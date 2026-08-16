import test from 'tape';
import {
  DuhGoodsReconciliationService,
  ReconciliationConflictError,
} from '../duhgoods/reconciliation/ReconciliationService';
import { ModelNameEnum } from 'models/types';
import { closeTestFyo, getTestFyo, setupTestFyo } from './helpers';

const fyo = getTestFyo();
setupTestFyo(fyo, __filename);

async function createSource(): Promise<string> {
  const source = fyo.doc.getNewDoc(ModelNameEnum.DuhGoodsImportSource);
  await source.setMultiple({
    sourceName: 'Reconciliation service test',
    sourceNamespace: 'test:reconciliation-service',
    sourceType: 'manual',
    importedAt: new Date('2026-08-01T00:00:00.000Z'),
    sourceHash: 's'.repeat(64),
    recordCount: 3,
    importedCount: 3,
    skippedCount: 0,
    exceptionCount: 0,
    errorCount: 0,
    status: 'imported',
  });
  await source.sync();
  return source.name as string;
}

async function createRecord(
  source: string,
  values: {
    sourceType: 'woocommerce' | 'psp_export';
    sourceId: string;
    transactionType: 'order' | 'payment';
    amount: string;
  }
): Promise<string> {
  const doc = fyo.doc.getNewDoc(ModelNameEnum.DuhGoodsImportRecord);
  await doc.setMultiple({
    importSource: source,
    sourceType: values.sourceType,
    sourceNamespace: `${values.sourceType}:service-test`,
    sourceId: values.sourceId,
    identityKey: `${values.sourceType}:${values.sourceId}`,
    rowLocator: 0,
    transactionType: values.transactionType,
    transactionDate: new Date('2026-08-01T00:00:00.000Z'),
    currency: 'SAR',
    grossAmount: fyo.pesa(values.amount),
    fees: fyo.pesa('0'),
    taxes: fyo.pesa('0'),
    netAmount: fyo.pesa(values.amount),
    status: 'pending',
    rawData: '{}',
    evidenceHash: values.sourceId.padEnd(64, 'x'),
    evidenceVersion: 1,
    priorEvidenceHash: '',
  });
  await doc.sync();
  return doc.name as string;
}

test('reconciliation service: persists idempotent proposals and preserves decisions', async (t) => {
  const source = await createSource();
  const order = await createRecord(source, {
    sourceType: 'woocommerce',
    sourceId: 'order-service',
    transactionType: 'order',
    amount: '100.00',
  });
  await createRecord(source, {
    sourceType: 'psp_export',
    sourceId: 'payment-service-1',
    transactionType: 'payment',
    amount: '100.00',
  });
  await createRecord(source, {
    sourceType: 'psp_export',
    sourceId: 'payment-service-2',
    transactionType: 'payment',
    amount: '100.00',
  });

  const service = new DuhGoodsReconciliationService(fyo);
  const firstRun = await service.generateProposals();
  const secondRun = await service.generateProposals();
  t.equal(firstRun.length, 2, 'all ambiguous candidates are persisted');
  t.equal(
    secondRun.length,
    2,
    'repeated proposal generation returns the same candidates'
  );
  t.equal(
    (await service.getMatches('proposed')).length,
    2,
    'repeated generation creates no duplicate rows'
  );

  const concurrentAccepts = await Promise.allSettled(
    (
      await service.getMatches('proposed')
    ).map((match) =>
      service.accept(match.name as string, 'reviewer@example.test')
    )
  );
  t.equal(
    concurrentAccepts.filter((result) => result.status === 'fulfilled').length,
    1,
    'concurrent conflicting accept requests cannot both succeed'
  );
  t.equal(
    (await service.getMatches('accepted')).length,
    1,
    'exactly one conflicting relationship is accepted'
  );
  t.equal(
    (await service.getUnmatchedRecords()).some(
      (record) => record.name === order
    ),
    false,
    'accepted records are not unmatched'
  );

  let conflict: Error | null = null;
  try {
    await service.accept(
      (
        await service.getMatches('proposed')
      )[0].name as string,
      'reviewer@example.test'
    );
  } catch (error) {
    conflict = error instanceof Error ? error : new Error(String(error));
  }
  t.ok(
    conflict instanceof ReconciliationConflictError,
    'conflicting acceptance fails safely'
  );

  const proposed = await service.getMatches('proposed');
  await service.reject(
    proposed[0].name as string,
    'reviewer@example.test',
    'Duplicate PSP export'
  );
  const rejected = await service.getMatches('rejected');
  t.equal(rejected.length, 1, 'a proposed match can be rejected');
  t.equal(
    rejected[0].decisionNotes,
    'Duplicate PSP export',
    'rejection history is retained'
  );

  let overwritten: Error | null = null;
  try {
    await service.reject(rejected[0].name as string, 'reviewer@example.test');
  } catch (error) {
    overwritten = error instanceof Error ? error : new Error(String(error));
  }
  t.ok(overwritten, 'a reviewed decision cannot be silently overwritten');
  t.end();
});

closeTestFyo(fyo, __filename);
