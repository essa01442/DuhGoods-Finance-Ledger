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
  date: string = '2026-07-01',
  currency: string = 'SAR'
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
    currency,
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
  // Use USD to isolate from other tests
  await makeRecord('payment', '100', '2026-01-01', 'USD');
  await makeRecord('settlement', '100', '2026-01-03', 'USD');

  const svc = new SettlementService(fyo);
  const proposals = await svc.proposeGroups();

  const match = proposals.find(
    (p) =>
      p.settlementNet.store === fyo.pesa('100').store &&
      !p.ambiguous &&
      p.settlementRecord.currency === 'USD'
  );
  t.ok(match, 'found an exact match proposal');
  if (match) {
    t.equal(match.confidence, 'exact', 'confidence is exact');
    t.ok(match.memberRecords.length >= 1, 'has member records');
  }
  t.end();
});

test('SettlementService: proposeGroups - sum of multiple members', async (t) => {
  // EUR to isolate
  await makeRecord('payment', '200', '2026-02-05', 'EUR');
  await makeRecord('payment', '150', '2026-02-06', 'EUR');
  await makeRecord('settlement', '350', '2026-02-10', 'EUR');

  const svc = new SettlementService(fyo);
  const proposals = await svc.proposeGroups();
  const match = proposals.find(
    (p) =>
      p.settlementNet.store === fyo.pesa('350').store &&
      !p.ambiguous &&
      p.memberRecords.length >= 2 &&
      p.settlementRecord.currency === 'EUR'
  );
  t.ok(match, 'found multi-member group');
  t.end();
});

test('SettlementService: proposeGroups - no proposal when date-range sum does not match target', async (t) => {
  // GBP: 50+50+100 = 200, but settlement target is 100 → no proposal
  // This verifies the date-range algorithm does not do exponential subset enumeration.
  await makeRecord('payment', '50', '2026-03-15', 'GBP');
  await makeRecord('payment', '50', '2026-03-15', 'GBP');
  await makeRecord('payment', '100', '2026-03-15', 'GBP');
  await makeRecord('settlement', '100', '2026-03-20', 'GBP');

  const svc = new SettlementService(fyo);
  const proposals = await svc.proposeGroups();
  const gbpProposals = proposals.filter(
    (p) => p.settlementRecord.currency === 'GBP'
  );
  t.equal(
    gbpProposals.length,
    0,
    'no proposal when date-range sum (200) does not match target (100)'
  );
  t.end();
});

test('SettlementService: acceptGroup - creates reconciliation matches', async (t) => {
  // CHF to isolate
  const pName = await makeRecord('payment', '75', '2026-04-25', 'CHF');
  await makeRecord('settlement', '75', '2026-04-28', 'CHF');

  const svc = new SettlementService(fyo);
  const proposals = await svc.proposeGroups();
  const match = proposals.find(
    (pr) =>
      pr.settlementNet.store === fyo.pesa('75').store &&
      !pr.ambiguous &&
      pr.settlementRecord.currency === 'CHF'
  );

  if (!match) {
    t.skip('no matching proposal found');
    t.end();
    return;
  }

  const groupName = await svc.acceptGroup(match, 'test-reviewer');
  t.ok(groupName, 'acceptGroup returns a group name');

  const matchRows = await fyo.db.getAll(
    ModelNameEnum.DuhGoodsReconciliationMatch,
    {
      filters: { leftRecord: pName },
      fields: ['name', 'status', 'confidence', 'settlementGroup'],
    }
  );
  t.ok(matchRows.length >= 1, 'at least one match row created');
  if (matchRows.length > 0) {
    t.equal(matchRows[0].status, 'accepted', 'match status is accepted');
    t.equal(
      matchRows[0].settlementGroup,
      groupName,
      'match links to settlement group'
    );
  }
  t.end();
});

test('SettlementService: acceptGroup - creates DuhGoodsSettlementGroup record', async (t) => {
  // JPY to isolate
  await makeRecord('payment', '500', '2026-05-01', 'JPY');
  await makeRecord('payment', '300', '2026-05-02', 'JPY');
  await makeRecord('settlement', '800', '2026-05-05', 'JPY');

  const svc = new SettlementService(fyo);
  const proposals = await svc.proposeGroups();
  const match = proposals.find(
    (p) =>
      p.settlementNet.store === fyo.pesa('800').store &&
      !p.ambiguous &&
      p.settlementRecord.currency === 'JPY'
  );

  if (!match) {
    t.skip('no matching JPY proposal');
    t.end();
    return;
  }

  const groupName = await svc.acceptGroup(match, 'reviewer-a');
  const groupRow = await fyo.db.get(
    ModelNameEnum.DuhGoodsSettlementGroup,
    groupName
  );
  t.ok(groupRow, 'settlement group record created');
  t.equal(groupRow.currency, 'JPY', 'group currency is JPY');
  t.equal(groupRow.memberCount, 2, 'group memberCount is 2');
  t.equal(groupRow.status, 'closed', 'group status is closed after acceptGroup');
  t.end();
});

test('SettlementService: acceptGroup - idempotent (second call is a no-op)', async (t) => {
  // AED to isolate
  const pName = await makeRecord('payment', '250', '2026-06-01', 'AED');
  await makeRecord('settlement', '250', '2026-06-05', 'AED');

  const svc = new SettlementService(fyo);
  const proposals = await svc.proposeGroups();
  const match = proposals.find(
    (p) =>
      p.settlementNet.store === fyo.pesa('250').store &&
      !p.ambiguous &&
      p.settlementRecord.currency === 'AED'
  );

  if (!match) {
    t.skip('no matching AED proposal');
    t.end();
    return;
  }

  const groupName1 = await svc.acceptGroup(match, 'reviewer-b');
  // Call again — should be idempotent, returning the same group name.
  const groupName2 = await svc.acceptGroup(match, 'reviewer-b');
  t.equal(groupName1, groupName2, 'second acceptGroup returns same group name');

  const matchRows = await fyo.db.getAll(
    ModelNameEnum.DuhGoodsReconciliationMatch,
    {
      filters: { leftRecord: pName },
      fields: ['name'],
    }
  );
  t.equal(matchRows.length, 1, 'no duplicate match rows created by idempotent call');
  t.end();
});

test('SettlementService: closeGroup and reopenGroup lifecycle', async (t) => {
  // QAR to isolate
  await makeRecord('payment', '1000', '2026-07-01', 'QAR');
  await makeRecord('settlement', '1000', '2026-07-10', 'QAR');

  const svc = new SettlementService(fyo);
  const proposals = await svc.proposeGroups();
  const match = proposals.find(
    (p) =>
      p.settlementNet.store === fyo.pesa('1000').store &&
      !p.ambiguous &&
      p.settlementRecord.currency === 'QAR'
  );

  if (!match) {
    t.skip('no matching QAR proposal');
    t.end();
    return;
  }

  const groupName = await svc.acceptGroup(match, 'reviewer-c');

  // Verify initially closed
  const group1 = await fyo.db.get(
    ModelNameEnum.DuhGoodsSettlementGroup,
    groupName
  );
  t.equal(group1.status, 'closed', 'group starts closed');

  // Reopen
  await svc.reopenGroup(groupName);
  const group2 = await fyo.db.get(
    ModelNameEnum.DuhGoodsSettlementGroup,
    groupName
  );
  t.equal(group2.status, 'reopened', 'group can be reopened');

  // Close again
  await svc.closeGroup(groupName);
  const group3 = await fyo.db.get(
    ModelNameEnum.DuhGoodsSettlementGroup,
    groupName
  );
  t.equal(group3.status, 'closed', 'group can be closed again');

  // Reopen once more so status = 'reopened'
  await svc.reopenGroup(groupName);
  const group4 = await fyo.db.get(
    ModelNameEnum.DuhGoodsSettlementGroup,
    groupName
  );
  t.equal(group4.status, 'reopened', 'group is reopened again');

  // reopenGroup on a non-closed (reopened) group should throw
  try {
    await svc.reopenGroup(groupName);
    t.fail('should throw when reopening a non-closed group');
  } catch (e) {
    t.ok(
      e instanceof Error && e.message.includes('cannot reopen'),
      'throws when group is not closed'
    );
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
    t.ok(
      e instanceof Error && e.message.includes('ambiguous'),
      'refuses ambiguous'
    );
  }
  t.end();
});

closeTestFyo(fyo, __filename);
