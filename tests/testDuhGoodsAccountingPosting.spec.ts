import test from 'tape';
import { DuhGoodsAccountingPostingService } from '../duhgoods/accounting/AccountingPostingService';
import { ImportOrchestrator } from '../duhgoods/importers/ImportOrchestrator';
import { WooCommerceImporter } from '../duhgoods/importers/WooCommerceImporter';
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
  currency?: string;
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
    currency: options.currency ?? 'SAR',
    grossAmount: fyo.pesa(amount),
    netAmount: fyo.pesa(amount),
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
  left: {
    sourceType: string;
    type: string;
    amount: string;
    options?: RecordOptions;
  },
  right: {
    sourceType: string;
    type: string;
    amount: string;
    options?: RecordOptions;
  },
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

async function assertBalanced(
  t: test.Test,
  postingName: string,
  message: string
) {
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
      options: {
        taxes: '15',
        rawData: '{"shipping_total":10,"discount_total":5}',
      },
    },
    { sourceType: 'psp_export', type: 'payment', amount: '100' }
  );
  const service = await postingService();
  const [postingName, concurrentName] = await Promise.all([
    service.post(match.name!),
    service.post(match.name!),
  ]);
  t.equal(
    concurrentName,
    postingName,
    'concurrent posts share one reservation'
  );
  t.equal(
    await service.post(match.name!),
    postingName,
    'repeat post is idempotent'
  );
  const posting = await fyo.doc.getDoc(
    ModelNameEnum.DuhGoodsAccountingPosting,
    postingName
  );
  await assertBalanced(t, postingName, 'order');
  const entries = await fyo.db.getAll(ModelNameEnum.AccountingLedgerEntry, {
    filters: { referenceName: posting.journalEntry as string },
    fields: ['name'],
  });
  t.ok(entries.length > 0, 'submitted JournalEntry creates ledger entries');
  const originalAuditHistory = posting.auditHistory as string;
  await Promise.all([
    service.reverse(postingName),
    service.reverse(postingName),
  ]);
  const reversed = await fyo.db.get(
    ModelNameEnum.DuhGoodsAccountingPosting,
    postingName
  );
  t.equal(reversed.status, 'reversed', 'reversal is retained as state');
  t.ok(
    (reversed.auditHistory as string).startsWith(
      originalAuditHistory.slice(0, -1)
    ),
    'reversal appends to the original audit history'
  );
  t.ok(
    (
      await fyo.db.getAll(ModelNameEnum.AccountingLedgerEntry, {
        filters: { referenceName: posting.journalEntry as string },
        fields: ['name'],
      })
    ).length > entries.length,
    'reversal creates offset entries'
  );
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
      right: {
        sourceType: 'bank_statement',
        type: 'bank_credit',
        amount: '90',
      },
    },
    {
      label: 'chargeback',
      left: { sourceType: 'psp_export', type: 'chargeback', amount: '-25' },
      right: {
        sourceType: 'bank_statement',
        type: 'bank_debit',
        amount: '-25',
      },
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
  const historicalException = await fyo.db.getAll(
    ModelNameEnum.DuhGoodsAccountingPosting,
    {
      filters: { reconciliationMatch: unaccepted.match.name! },
      fields: ['name', 'status', 'auditHistory'],
    }
  );
  t.equal(historicalException.length, 1, 'unaccepted attempt is recorded');
  t.equal(
    historicalException[0].status,
    'exception',
    'unaccepted attempt row has exception status'
  );
  const unacceptedMatch = await fyo.doc.getDoc(
    ModelNameEnum.DuhGoodsReconciliationMatch,
    unaccepted.match.name!
  );
  await unacceptedMatch.set('status', 'accepted');
  await unacceptedMatch.sync();
  const acceptedPostingName = await service.post(unaccepted.match.name!);
  t.notEqual(
    acceptedPostingName,
    historicalException[0].name,
    'accepted retry creates a fresh posting row, not reusing the exception record'
  );
  t.equal(
    await service.post(unaccepted.match.name!),
    acceptedPostingName,
    'accepted retry remains idempotent'
  );
  const acceptedJournals = await fyo.db.getAll(ModelNameEnum.JournalEntry, {
    filters: { referenceNumber: `DuhGoods:${unaccepted.match.name}` },
    fields: ['name'],
  });
  t.equal(
    acceptedJournals.length,
    1,
    'accepted retry creates one JournalEntry'
  );
  const acceptedPosting = await fyo.db.get(
    ModelNameEnum.DuhGoodsAccountingPosting,
    acceptedPostingName
  );
  t.equal(
    acceptedPosting.status,
    'posted',
    'accepted posting row has posted status'
  );
  const preservedExceptionRow = await fyo.db.get(
    ModelNameEnum.DuhGoodsAccountingPosting,
    historicalException[0].name as string
  );
  t.equal(
    preservedExceptionRow.status,
    'exception',
    'exception row preserved as historical evidence after successful retry'
  );
  t.ok(
    (preservedExceptionRow.auditHistory as string).includes('unaccepted_match'),
    'exception row audit history captures the unaccepted attempt'
  );

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
  t.end();
});

test('accounting posting: uses commercial facts from actual WooCommerce orchestrator evidence', async (t) => {
  const result = await new ImportOrchestrator(
    fyo,
    new WooCommerceImporter()
  ).import(
    JSON.stringify([
      {
        id: 'woo-commercial-facts',
        status: 'completed',
        currency: 'SAR',
        date_paid: '2026-08-01T00:00:00.000Z',
        total: '100.125',
        total_tax: '15.125',
        shipping_total: '10.25',
        discount_total: '5.50',
      },
    ]),
    {
      sourceName: 'Woo commercial facts',
      sourceNamespace: 'woo:commercial-facts',
    }
  );
  const order = (
    await fyo.db.getAll(ModelNameEnum.DuhGoodsImportRecord, {
      filters: { importSource: result.sourceId },
      fields: ['name', 'evidenceHash'],
    })
  )[0];
  const payment = await record(
    result.sourceId,
    'payment',
    'psp_export',
    '100.125'
  );
  const match = fyo.doc.getNewDoc(ModelNameEnum.DuhGoodsReconciliationMatch);
  await match.setMultiple({
    importRecord: order.name,
    matchType: 'imported_evidence',
    matchedDocument: payment.name,
    matchedDocumentType: ModelNameEnum.DuhGoodsImportRecord,
    leftRecord: order.name,
    rightRecord: payment.name,
    edgeKey: [order.name, payment.name].sort().join(':'),
    confidence: 'exact',
    status: 'accepted',
    matchedAt: new Date(),
    amountDelta: fyo.pesa(0),
    dateDeltaDays: 0,
    leftEvidenceHash: order.evidenceHash as string,
    rightEvidenceHash: payment.evidenceHash as string,
    evidenceSnapshot: '{}',
  });
  await match.sync();
  const postingName = await (await postingService()).post(match.name!);
  const posting = await fyo.db.get(
    ModelNameEnum.DuhGoodsAccountingPosting,
    postingName
  );
  const journal = await fyo.doc.getDoc(
    ModelNameEnum.JournalEntry,
    posting.journalEntry as string
  );
  const credits = (journal.accounts as { credit: Money }[]).map(
    (line) => line.credit
  );
  const hasCredit = (amount: string) =>
    credits.some((credit) => credit.sub(fyo.pesa(amount)).isZero());
  t.ok(hasCredit('80.25'), 'sales applies Woo shipping and discount totals');
  t.ok(hasCredit('15.125'), 'tax precision is preserved');
  t.ok(hasCredit('10.25'), 'shipping precision is preserved');
  await assertBalanced(t, postingName, 'Woo importer output');
  t.end();
});

test('accounting posting: rejects foreign currency without explicit FX evidence', async (t) => {
  const { match } = await fixture(
    {
      sourceType: 'woocommerce',
      type: 'order',
      amount: '999999999999.123456',
      options: { taxes: '0', currency: 'USD' },
    },
    {
      sourceType: 'psp_export',
      type: 'payment',
      amount: '999999999999.123456',
      options: { currency: 'USD' },
    }
  );
  try {
    await (await postingService()).post(match.name!);
    t.fail('foreign currency must not post without FX evidence');
  } catch (error) {
    t.equal(
      (error as Error).message,
      'Foreign-currency evidence requires explicit FX evidence before posting',
      'requires_fx exception is explicit'
    );
  }
  t.end();
});

test('accounting posting: recovers a persisted reservation without duplicate journals', async (t) => {
  const { match } = await fixture(
    { sourceType: 'woocommerce', type: 'order', amount: '42.125' },
    { sourceType: 'psp_export', type: 'payment', amount: '42.125' }
  );
  const reservation = fyo.doc.getNewDoc(
    ModelNameEnum.DuhGoodsAccountingPosting
  );
  await reservation.setMultiple({
    reconciliationMatch: match.name,
    idempotencyKey: `interrupted:${match.name}`,
    postingType: 'order_payment',
    status: 'reserving',
    evidenceSnapshot: '[]',
    accountSnapshot: '{}',
    auditHistory: JSON.stringify([
      { action: 'reserved', at: new Date().toISOString() },
    ]),
  });
  await reservation.sync();
  const service = await postingService();
  const [first, second] = await Promise.all([
    service.post(match.name!),
    service.post(match.name!),
  ]);
  t.equal(first, second, 'concurrent recovery reuses one reservation');
  const journals = await fyo.db.getAll(ModelNameEnum.JournalEntry, {
    filters: { referenceNumber: `DuhGoods:${match.name}` },
    fields: ['name'],
  });
  t.equal(journals.length, 1, 'recovery creates exactly one JournalEntry');
  await assertBalanced(t, first, 'recovered reservation');
  const posting = await fyo.doc.getDoc(
    ModelNameEnum.DuhGoodsAccountingPosting,
    first
  );
  await posting.set('auditHistory', '[]');
  try {
    await posting.sync();
    t.fail('reviewed audit history must not be replaceable');
  } catch (error) {
    t.equal(
      (error as Error).message,
      'DuhGoodsAccountingPosting: audit history may only be appended',
      'audit history replacement is rejected'
    );
  }
  t.end();
});

test('accounting posting scenario 1: exception row remains auditable after accepted retry', async (t) => {
  const service = await postingService();
  const { match } = await fixture(
    { sourceType: 'woocommerce', type: 'order', amount: '50' },
    { sourceType: 'psp_export', type: 'payment', amount: '50' },
    'proposed'
  );
  // Step 1: posting attempt on proposed match — rejected, exception row created.
  try {
    await service.post(match.name!);
  } catch {
    /* expected */
  }
  const noJournals = await fyo.db.getAll(ModelNameEnum.JournalEntry, {
    filters: { referenceNumber: `DuhGoods:${match.name}` },
    fields: ['name'],
  });
  t.equal(noJournals.length, 0, 'no JournalEntry after failed first attempt');
  // Step 2: accept the match.
  const matchDoc = await fyo.doc.getDoc(
    ModelNameEnum.DuhGoodsReconciliationMatch,
    match.name!
  );
  await matchDoc.set('status', 'accepted');
  await matchDoc.sync();
  // Step 3: retry succeeds, returns a NEW posting name (not the exception row).
  const postingName = await service.post(match.name!);
  // Step 4: idempotent — repeated call returns the same name.
  t.equal(
    await service.post(match.name!),
    postingName,
    'posting is idempotent after success'
  );
  // Two rows exist: one exception (historical), one posted (active).
  const allRows = await fyo.db.getAll(ModelNameEnum.DuhGoodsAccountingPosting, {
    filters: { reconciliationMatch: match.name! },
    fields: ['name', 'status', 'idempotencyKey'],
  });
  const exceptionRows = allRows.filter((r) => r.status === 'exception');
  const postedRows = allRows.filter((r) => r.status === 'posted');
  t.equal(allRows.length, 2, 'both exception and posted rows exist');
  t.equal(exceptionRows.length, 1, 'exactly one exception row preserved');
  t.equal(postedRows.length, 1, 'exactly one posted row');
  t.equal(postedRows[0].name, postingName, 'posted row matches returned name');
  // Exactly one JournalEntry.
  const journals = await fyo.db.getAll(ModelNameEnum.JournalEntry, {
    filters: { referenceNumber: `DuhGoods:${match.name}` },
    fields: ['name'],
  });
  t.equal(
    journals.length,
    1,
    'exactly one JournalEntry created after accepted retry'
  );
  await assertBalanced(t, postingName, 'scenario 1 accepted retry');
  t.end();
});

test('accounting posting scenario 2: crash-recovery revalidation failure leaves no stranded reserving rows', async (t) => {
  const service = await postingService();
  // Create an accepted match with supersede-able evidence.
  const { match, leftRecord } = await fixture(
    {
      sourceType: 'woocommerce',
      type: 'order',
      amount: '30',
      options: { identityKey: 'scenario2-order' },
    },
    { sourceType: 'psp_export', type: 'payment', amount: '30' }
  );
  // Plant a 'reserving' row simulating a crash before the JournalEntry was created.
  const crashedReservation = fyo.doc.getNewDoc(
    ModelNameEnum.DuhGoodsAccountingPosting
  );
  await crashedReservation.setMultiple({
    reconciliationMatch: match.name,
    idempotencyKey: `${match.name}:${
      leftRecord.evidenceHash as string
    }:SCENARIO2`,
    postingType: 'order_payment',
    status: 'reserving',
    evidenceSnapshot: '[]',
    accountSnapshot: '{}',
    auditHistory: JSON.stringify([
      { action: 'reserved', at: new Date().toISOString() },
    ]),
  });
  await crashedReservation.sync();
  // Supersede the left evidence before crash-recovery runs.
  await record(
    leftRecord.importSource as string,
    'order',
    'woocommerce',
    '30',
    { identityKey: 'scenario2-order', evidenceVersion: 2 }
  );
  // Crash-recovery re-validates evidence, finds it superseded, must not strand.
  try {
    await service.post(match.name!);
    t.fail('superseded evidence during crash recovery must not post');
  } catch (error) {
    t.ok(
      (error as Error).message.includes('superseded'),
      `crash-recovery throws on superseded evidence: "${
        (error as Error).message
      }"`
    );
  }
  // No rows left stuck in 'reserving'.
  const reservingRows = await fyo.db.getAll(
    ModelNameEnum.DuhGoodsAccountingPosting,
    {
      filters: { reconciliationMatch: match.name! },
      fields: ['name', 'status'],
    }
  );
  const stranded = reservingRows.filter((r) => r.status === 'reserving');
  t.equal(stranded.length, 0, 'no rows left stranded in reserving state');
  // The crashed reservation row should now be exception.
  const crashedRow = await fyo.db.get(
    ModelNameEnum.DuhGoodsAccountingPosting,
    crashedReservation.name as string
  );
  t.equal(
    crashedRow.status,
    'exception',
    'crashed reservation transitioned to exception by markReservationFailed()'
  );
  t.end();
});

closeTestFyo(fyo, __filename);
