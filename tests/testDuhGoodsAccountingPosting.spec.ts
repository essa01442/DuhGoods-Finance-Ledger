import test from 'tape';
import { DuhGoodsAccountingPostingService } from '../duhgoods/accounting/AccountingPostingService';
import { ModelNameEnum } from 'models/types';
import type { Money } from 'pesa';
import { closeTestFyo, getTestFyo, setupTestFyo } from './helpers';

const fyo = getTestFyo();
setupTestFyo(fyo, __filename);
let sequence = 0;

type RecordOptions = {
  fees?: string;
  taxes?: string;
  rawData?: string;
  identityKey?: string;
  evidenceVersion?: number;
};

async function record(
  source: string,
  type: string,
  sourceType: string,
  amount: string,
  options: RecordOptions = {}
) {
  const doc = fyo.doc.getNewDoc(ModelNameEnum.DuhGoodsImportRecord);
  const id = `${sourceType}-${type}-${amount}-${++sequence}`;
  await doc.setMultiple({
    importSource: source,
    sourceType,
    sourceNamespace: 'posting-test',
    sourceId: id,
    identityKey: options.identityKey ?? id,
    rowLocator: 1,
    transactionType: type,
    transactionDate: new Date('2026-08-01T00:00:00.000Z'),
    currency: 'SAR',
    grossAmount: fyo.pesa(amount), netAmount: fyo.pesa(amount),
    fees: fyo.pesa(options.fees ?? 0),
    taxes: fyo.pesa(options.taxes ?? 0),
    status: 'pending',
    rawData: options.rawData ?? '{}',
    evidenceHash: id.padEnd(64, 'x'),
    evidenceVersion: options.evidenceVersion ?? 1,
    priorEvidenceHash: '',
  });
  await doc.sync();
  return doc;
}

async function fixture(
  left: { sourceType: string; type: string; amount: string; options?: RecordOptions },
  right: { sourceType: string; type: string; amount: string; options?: RecordOptions },
  status = 'accepted'
) {
  const sourceId = `posting-${++sequence}`;
  const source = fyo.doc.getNewDoc(ModelNameEnum.DuhGoodsImportSource);
  await source.setMultiple({
    sourceName: sourceId,
    sourceNamespace: 'posting-test',
    sourceType: 'manual',
    importedAt: new Date(),
    sourceHash: sourceId.padEnd(64, 's'),
    recordCount: 2,
    importedCount: 2,
    skippedCount: 0,
    exceptionCount: 0,
    errorCount: 0,
    status: 'imported',
  });
  await source.sync();
  const leftRecord = await record(
    source.name!,
    left.type,
    left.sourceType,
    left.amount,
    left.options
  );
  const rightRecord = await record(
    source.name!,
    right.type,
    right.sourceType,
    right.amount,
    right.options
  );
  const match = fyo.doc.getNewDoc(ModelNameEnum.DuhGoodsReconciliationMatch);
  await match.setMultiple({
    importRecord: leftRecord.name,
    matchType: 'imported_evidence',
    matchedDocument: rightRecord.name,
    matchedDocumentType: ModelNameEnum.DuhGoodsImportRecord,
    leftRecord: leftRecord.name,
    rightRecord: rightRecord.name,
    edgeKey: [leftRecord.name, rightRecord.name].sort().join(':'),
    confidence: 'exact',
    status,
    matchedAt: new Date(),
    amountDelta: fyo.pesa(0),
    dateDeltaDays: 0,
    leftEvidenceHash: leftRecord.evidenceHash as string,
    rightEvidenceHash: rightRecord.evidenceHash as string,
    evidenceSnapshot: '{}',
  });
  await match.sync();
  return { leftRecord, match, rightRecord };
}

async function postingService() {
  const accounts = await fyo.db.getAll(ModelNameEnum.Account, {
    fields: ['name'],
    limit: 8,
  });
  return new DuhGoodsAccountingPostingService(fyo, {
    pspClearing: accounts[0].name as string,
    bank: accounts[1].name as string,
    sales: accounts[2].name as string,
    refunds: accounts[3].name as string,
    chargebacks: accounts[4].name as string,
    feeExpense: accounts[5].name as string,
    taxPayable: accounts[6].name as string,
    shippingRevenue: accounts[7].name as string,
    discounts: accounts[4].name as string,
  });
}

async function assertBalanced(t: test.Test, postingName: string, message: string) {
  const posting = await fyo.db.get(
    ModelNameEnum.DuhGoodsAccountingPosting,
    postingName
  );
  const journal = await fyo.doc.getDoc(
    ModelNameEnum.JournalEntry,
    posting.journalEntry as string
  );
  const lines = journal.accounts as { debit: Money; credit: Money }[];
  const debit = lines.reduce(
    (total, line) => total.add(line.debit),
    fyo.pesa(0)
  );
  const credit = lines.reduce(
    (total, line) => total.add(line.credit),
    fyo.pesa(0)
  );
  t.ok(debit.sub(credit).isZero(), `${message} JournalEntry is balanced`);
}

test('accounting posting: posts accepted order exactly once and reverses without deleting its audit history', async (t) => {
  const { match } = await fixture(
    {
      sourceType: 'woocommerce',
      type: 'order',
      amount: '100',
      options: { taxes: '15', rawData: '{"shippingAmount":10,"discountAmount":5}' },
    },
    { sourceType: 'psp_export', type: 'payment', amount: '100' }
  );
  const service = await postingService();
  const [postingName, concurrentName] = await Promise.all([
    service.post(match.name!),
    service.post(match.name!),
  ]);
  t.equal(concurrentName, postingName, 'concurrent posts share one reservation');
  t.equal(await service.post(match.name!), postingName, 'repeat post is idempotent');
  const posting = await fyo.doc.getDoc(ModelNameEnum.DuhGoodsAccountingPosting, postingName);
  await assertBalanced(t, postingName, 'order');
  const entries = await fyo.db.getAll(ModelNameEnum.AccountingLedgerEntry, {
    filters: { referenceName: posting.journalEntry as string }, fields: ['name'],
  });
  t.ok(entries.length > 0, 'submitted JournalEntry creates ledger entries');
  const originalAuditHistory = posting.auditHistory as string;
  await Promise.all([service.reverse(postingName), service.reverse(postingName)]);
  const reversed = await fyo.db.get(ModelNameEnum.DuhGoodsAccountingPosting, postingName);
  t.equal(reversed.status, 'reversed', 'reversal is retained as state');
  t.ok(
    (reversed.auditHistory as string).startsWith(
      originalAuditHistory.slice(0, -1)
    ),
    'reversal appends to the original audit history'
  );
  t.ok((await fyo.db.getAll(ModelNameEnum.AccountingLedgerEntry, { filters: { referenceName: posting.journalEntry as string }, fields: ['name'] })).length > entries.length, 'reversal creates offset entries');
  t.end();
});

test('accounting posting: produces balanced refund, settlement, and chargeback JournalEntries', async (t) => {
  const service = await postingService();
  const scenarios = [
    {
      label: 'refund',
      left: { sourceType: 'woocommerce', type: 'refund', amount: '-40' },
      right: { sourceType: 'psp_export', type: 'refund', amount: '-40' },
    },
    {
      label: 'settlement',
      left: {
        sourceType: 'psp_export',
        type: 'settlement',
        amount: '90',
        options: { fees: '7', taxes: '3' },
      },
      right: { sourceType: 'bank_statement', type: 'bank_credit', amount: '90' },
    },
    {
      label: 'chargeback',
      left: { sourceType: 'psp_export', type: 'chargeback', amount: '-25' },
      right: { sourceType: 'bank_statement', type: 'bank_debit', amount: '-25' },
    },
  ];
  for (const scenario of scenarios) {
    const { match } = await fixture(scenario.left, scenario.right);
    await assertBalanced(t, await service.post(match.name!), scenario.label);
  }
  t.end();
});

test('accounting posting: blocks unaccepted and superseded reconciliation evidence', async (t) => {
  const service = await postingService();
  const unaccepted = await fixture(
    { sourceType: 'woocommerce', type: 'order', amount: '10' },
    { sourceType: 'psp_export', type: 'payment', amount: '10' },
    'proposed'
  );
  try {
    await service.post(unaccepted.match.name!);
    t.fail('unaccepted reconciliation must not post');
  } catch (error) {
    t.equal(
      (error as Error).message,
      'Only accepted reconciliations can be posted',
      'unaccepted reconciliation reports a posting exception'
    );
  }

  const superseded = await fixture(
    {
      sourceType: 'woocommerce',
      type: 'order',
      amount: '20',
      options: { identityKey: 'superseded-order' },
    },
    { sourceType: 'psp_export', type: 'payment', amount: '20' }
  );
  await record(
    superseded.leftRecord.importSource as string,
    'order',
    'woocommerce',
    '20',
    { identityKey: 'superseded-order', evidenceVersion: 2 }
  );
  try {
    await service.post(superseded.match.name!);
    t.fail('superseded evidence must not post');
  } catch (error) {
    t.equal(
      (error as Error).message,
      'Accepted reconciliation uses superseded evidence',
      'superseded reconciliation reports a posting exception'
    );
  }
  const journals = await fyo.db.getAll(ModelNameEnum.JournalEntry, {
    filters: { referenceNumber: `DuhGoods:${unaccepted.match.name}` },
    fields: ['name'],
  });
  t.equal(journals.length, 0, 'unaccepted reconciliation has no JournalEntry');
  t.end();
});

closeTestFyo(fyo, __filename);
