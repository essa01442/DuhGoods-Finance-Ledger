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
    identityKey?: string;
    evidenceVersion?: number;
    status?: 'pending' | 'exception';
  }
): Promise<string> {
  const doc = fyo.doc.getNewDoc(ModelNameEnum.DuhGoodsImportRecord);
  await doc.setMultiple({
    importSource: source,
    sourceType: values.sourceType,
    sourceNamespace: `${values.sourceType}:service-test`,
    sourceId: values.sourceId,
    identityKey:
      values.identityKey ?? `${values.sourceType}:${values.sourceId}`,
    rowLocator: 0,
    transactionType: values.transactionType,
    transactionDate: new Date('2026-08-01T00:00:00.000Z'),
    currency: 'SAR',
    grossAmount: fyo.pesa(values.amount),
    fees: fyo.pesa('0'),
    taxes: fyo.pesa('0'),
    netAmount: fyo.pesa(values.amount),
    status: values.status ?? 'pending',
    rawData: '{}',
    evidenceHash: values.sourceId.padEnd(64, 'x'),
    evidenceVersion: values.evidenceVersion ?? 1,
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
    amount: '777.77',
  });
  await createRecord(source, {
    sourceType: 'psp_export',
    sourceId: 'payment-service-1',
    transactionType: 'payment',
    amount: '777.77',
  });
  await createRecord(source, {
    sourceType: 'psp_export',
    sourceId: 'payment-service-2',
    transactionType: 'payment',
    amount: '777.77',
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

test('reconciliation service: recomputes persisted proposal ambiguity without changing evidence', async (t) => {
  const source = await createSource();
  await createRecord(source, {
    sourceType: 'woocommerce',
    sourceId: 'order-recompute',
    transactionType: 'order',
    amount: '555.55',
  });
  await createRecord(source, {
    sourceType: 'psp_export',
    sourceId: 'payment-recompute-1',
    transactionType: 'payment',
    amount: '555.55',
  });

  const service = new DuhGoodsReconciliationService(fyo);
  await service.generateProposals();
  const initial = await service.getMatches('proposed');
  t.equal(initial.length, 1, 'first run persists one candidate');
  t.equal(
    initial[0].confidence,
    'high',
    'single candidate starts high confidence'
  );

  await createRecord(source, {
    sourceType: 'psp_export',
    sourceId: 'payment-recompute-2',
    transactionType: 'payment',
    amount: '555.55',
  });
  await service.generateProposals();

  const recomputed = await service.getMatches('proposed');
  t.equal(recomputed.length, 2, 'second run persists both valid candidates');
  t.ok(
    recomputed.every((match) => match.confidence === 'medium'),
    'existing and new candidates both reflect ambiguity'
  );
  t.ok(
    recomputed.every((match) =>
      String(match.reasonCodes).includes('ambiguous_candidates')
    ),
    'ambiguity reason is persisted for both candidates'
  );
  const updated = recomputed.find((match) => match.name === initial[0].name)!;
  t.equal(
    JSON.parse(updated.assessmentHistory as string).length,
    2,
    'the original high assessment remains auditable after recomputation'
  );

  await Promise.all([service.generateProposals(), service.generateProposals()]);
  t.equal(
    (await service.getMatches('proposed')).length,
    2,
    'concurrent repeated generation remains idempotent'
  );
  t.end();
});

test('reconciliation service: supersedes proposals absent from latest eligibility', async (t) => {
  const service = new DuhGoodsReconciliationService(fyo);

  const exceptionSource = await createSource();
  const exceptionOrder = await createRecord(exceptionSource, {
    sourceType: 'woocommerce',
    sourceId: 'order-exception-v1',
    transactionType: 'order',
    amount: '333.33',
  });
  const exceptionPayment = await createRecord(exceptionSource, {
    sourceType: 'psp_export',
    sourceId: 'payment-exception',
    transactionType: 'payment',
    amount: '333.33',
  });
  await service.generateProposals();
  await createRecord(exceptionSource, {
    sourceType: 'woocommerce',
    sourceId: 'order-exception-v2',
    transactionType: 'order',
    amount: '333.33',
    identityKey: 'woocommerce:order-exception-v1',
    evidenceVersion: 2,
    status: 'exception',
  });
  await service.generateProposals();

  const exceptionMatch = (await service.getMatches()).find(
    (match) =>
      match.edgeKey === [exceptionOrder, exceptionPayment].sort().join(':')
  )!;
  t.equal(
    exceptionMatch.status,
    'superseded',
    'latest exception evidence supersedes the stale proposed edge'
  );
  t.ok(exceptionMatch.supersededAt, 'supersession is auditable');

  let staleAcceptance: Error | null = null;
  try {
    await service.accept(
      exceptionMatch.name as string,
      'reviewer@example.test'
    );
  } catch (error) {
    staleAcceptance = error instanceof Error ? error : new Error(String(error));
  }
  t.match(
    staleAcceptance?.message ?? '',
    /Only proposed reconciliations can be accepted/,
    'a superseded edge cannot be accepted'
  );

  const eligibilitySource = await createSource();
  const eligibilityOrder = await createRecord(eligibilitySource, {
    sourceType: 'woocommerce',
    sourceId: 'order-eligibility-v1',
    transactionType: 'order',
    amount: '444.44',
  });
  const eligibilityPayment = await createRecord(eligibilitySource, {
    sourceType: 'psp_export',
    sourceId: 'payment-eligibility',
    transactionType: 'payment',
    amount: '444.44',
  });
  await service.generateProposals();
  await createRecord(eligibilitySource, {
    sourceType: 'woocommerce',
    sourceId: 'order-eligibility-v2',
    transactionType: 'order',
    amount: '555.55',
    identityKey: 'woocommerce:order-eligibility-v1',
    evidenceVersion: 2,
  });
  await service.generateProposals();

  const eligibilityMatch = (await service.getMatches()).find(
    (match) =>
      match.edgeKey === [eligibilityOrder, eligibilityPayment].sort().join(':')
  )!;
  t.equal(
    eligibilityMatch.status,
    'superseded',
    'a proposal removed by changed eligibility is superseded, not deleted'
  );
  t.end();
});

closeTestFyo(fyo, __filename);
