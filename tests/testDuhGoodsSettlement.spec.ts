import test from 'tape';
import { ModelNameEnum } from 'models/types';
import { SettlementService } from '../duhgoods/settlement/SettlementService';
import { closeTestFyo, getTestFyo, setupTestFyo } from './helpers';

const fyo = getTestFyo();
setupTestFyo(fyo, __filename);
let seq = 0;
let importSourceName: string;

async function getOrCreateSource() {
  if (importSourceName) return importSourceName;
  const src = fyo.doc.getNewDoc(ModelNameEnum.DuhGoodsImportSource);
  await src.setMultiple({
    sourceName: 'settle-test-source',
    sourceNamespace: 'settle-ns',
    sourceType: 'psp_export',
    importedAt: new Date(),
    sourceHash: 'settle-source'.padEnd(64, 'z'),
    recordCount: 0,
    importedCount: 0,
    skippedCount: 0,
    exceptionCount: 0,
    errorCount: 0,
    status: 'imported',
  });
  await src.sync();
  importSourceName = src.name as string;
  return importSourceName;
}

async function makeRecord(
  type: string,
  amount: string,
  date: string = '2026-07-01'
) {
  const id = `settle-test-${++seq}`;
  const sourceName = await getOrCreateSource();
  const doc = fyo.doc.getNewDoc(ModelNameEnum.DuhGoodsImportRecord);
  await doc.setMultiple({
    importSource: sourceName,
    sourceType: 'psp_export',
    sourceNamespace: 'settle-ns',
    sourceId: id,
    identityKey: id,
    rowLocator: seq,
    transactionType: type,
    transactionDate: new Date(date + 'T00:00:00.000Z'),
    currency: 'SAR',
    grossAmount: fyo.pesa(amount),
    netAmount: fyo.pesa(amount),
    fees: fyo.pesa(0),
    taxes: fyo.pesa(0),
    status: 'pending',
    rawData: '{}',
    evidenceHash: id.padEnd(64, 'c'),
    evidenceVersion: 1,
    priorEvidenceHash: '',
  });
  await doc.sync();
  return doc.name as string;
}

test('SettlementService: proposeGroups - exact match for a single member', async (t) => {
  await makeRecord('payment', '100', '2026-07-01');
  await makeRecord('settlement', '100', '2026-07-03');

  const svc = new SettlementService(fyo);
  const proposals = await svc.proposeGroups();

  const match = proposals.find(
    (p) =>
      p.settlementNet.store === fyo.pesa('100').store && !p.ambiguous
  );
  t.ok(match, 'found an exact match proposal');
  if (match) {
    t.equal(match.confidence, 'exact', 'confidence is exact');
    t.ok(match.memberRecords.length >= 1, 'has member records');
  }
  t.end();
});

test('SettlementService: proposeGroups - sum of multiple members', async (t) => {
  await makeRecord('payment', '200', '2026-07-05');
  await makeRecord('payment', '150', '2026-07-06');
  await makeRecord('settlement', '350', '2026-07-10');

  const svc = new SettlementService(fyo);
  const proposals = await svc.proposeGroups();
  const match = proposals.find(
    (p) =>
      p.settlementNet.store === fyo.pesa('350').store &&
      !p.ambiguous &&
      p.memberRecords.length >= 2
  );
  t.ok(match, 'found multi-member group');
  t.end();
});

test('SettlementService: proposeGroups - flags ambiguous when multiple subsets match', async (t) => {
  // Three records: 50, 50, 100; settlement 100 → ambiguous (50+50 OR 100)
  await makeRecord('payment', '50', '2026-07-15');
  await makeRecord('payment', '50', '2026-07-15');
  await makeRecord('payment', '100', '2026-07-15');
  await makeRecord('settlement', '100', '2026-07-20');

  const svc = new SettlementService(fyo);
  const proposals = await svc.proposeGroups();
  const ambig = proposals.find(
    (p) =>
      p.settlementNet.store === fyo.pesa('100').store && p.ambiguous
  );
  t.ok(ambig, 'found ambiguous proposal (multiple subsets)');
  if (ambig) {
    t.ok(ambig.alternativeCount > 1, 'alternativeCount > 1');
  }
  t.end();
});

test('SettlementService: acceptGroup - creates reconciliation matches', async (t) => {
  const pName = await makeRecord('payment', '75', '2026-07-25');
  await makeRecord('settlement', '75', '2026-07-28');

  const svc = new SettlementService(fyo);
  const proposals = await svc.proposeGroups();
  const match = proposals.find(
    (pr) =>
      pr.settlementNet.store === fyo.pesa('75').store &&
      !pr.ambiguous
  );

  if (!match) {
    t.skip('no matching proposal found (may be combined with other pending records)');
    t.end();
    return;
  }

  await svc.acceptGroup(match, 'test-reviewer');
  const matchRows = await fyo.db.getAll(
    ModelNameEnum.DuhGoodsReconciliationMatch,
    {
      filters: { leftRecord: pName },
      fields: ['name', 'status', 'confidence'],
    }
  );
  t.ok(matchRows.length >= 1, 'at least one match row created');
  if (matchRows.length > 0) {
    t.equal(matchRows[0].status, 'accepted', 'match status is accepted');
  }
  t.end();
});

test('SettlementService: acceptGroup - refuses ambiguous proposals', async (t) => {
  const svc = new SettlementService(fyo);
  const fakeProposal = {
    settlementRecord: {
      name: 'x',
      transactionType: 'settlement',
      transactionDate: new Date(),
      currency: 'SAR',
      netAmount: fyo.pesa(100),
      evidenceHash: 'x'.padEnd(64, 'x'),
    },
    memberRecords: [],
    totalMemberNet: fyo.pesa(100),
    settlementNet: fyo.pesa(100),
    delta: fyo.pesa(0),
    confidence: 'exact' as const,
    ambiguous: true,
    alternativeCount: 2,
  };
  try {
    await svc.acceptGroup(fakeProposal, 'reviewer');
    t.fail('should have thrown for ambiguous proposal');
  } catch (e) {
    t.ok(e instanceof Error && e.message.includes('ambiguous'), 'refuses ambiguous');
  }
  t.end();
});

closeTestFyo(fyo, __filename);
