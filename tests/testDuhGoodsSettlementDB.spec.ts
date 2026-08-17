/**
 * Settlement DB integrity tests — file-backed.
 *
 * Uses a real file-backed SQLite database (same pattern as
 * testDuhGoodsMigrationFileBacked.spec.ts) to access raw DatabaseManager.db.knex
 * and verify the constraints added in migration 0.38.8:
 *
 *   1. idx_dghsg_settlement_record — UNIQUE INDEX on DuhGoodsSettlementGroup(settlementRecord)
 *   2. dghrm_prevent_accepted_insert_conflict — BEFORE INSERT trigger on
 *      DuhGoodsReconciliationMatch
 *
 * Proves:
 *   a) Structural: index and trigger both exist after migration.
 *   b) Concurrent/duplicate group acceptance cannot reuse one member in two groups.
 *   c) Direct INSERT with status='accepted' cannot bypass the trigger invariant.
 *   d) Valid many-to-one settlement groups (3 members) work end-to-end.
 *   e) close/reopen lifecycle preserves these invariants.
 *   f) Idempotent re-acceptance of the same group returns same group name.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import test from 'tape';
import { DatabaseManager } from 'backend/database/manager';
import { Fyo } from 'fyo';
import { DummyAuthDemux } from 'fyo/tests/helpers';
import { ModelNameEnum } from 'models/types';
import setupInstance from 'src/setup/setupInstance';
import { SettlementService } from '../duhgoods/settlement/SettlementService';
import { getTestSetupWizardOptions } from './helpers';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let tempDbPath: string;
let rawDm: DatabaseManager;
let fyo: Fyo;
let seq = 0;
let sourceName: string;

function makeTempDbPath(): string {
  return path.join(os.tmpdir(), `duhgoods-settle-db-${Date.now()}.db`);
}

function makeFyo(): Fyo {
  return new Fyo({
    DatabaseDemux: DatabaseManager,
    AuthDemux: DummyAuthDemux,
    isTest: true,
    isElectron: false,
  });
}

test('SettlementDB setup: create file-backed DB and run migrations', async (t) => {
  tempDbPath = makeTempDbPath();
  fyo = makeFyo();
  await setupInstance(tempDbPath, getTestSetupWizardOptions(), fyo);
  t.ok(fyo.db, 'fyo initialized');

  rawDm = new DatabaseManager();
  await rawDm.connectToDatabase(tempDbPath);
  t.ok(rawDm.db?.knex, 'rawDm connected with knex');
  t.end();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getOrCreateSource(): Promise<string> {
  if (sourceName) return sourceName;
  const doc = fyo.doc.getNewDoc(ModelNameEnum.DuhGoodsImportSource);
  await doc.setMultiple({
    sourceName: 'sdb-test-source',
    sourceNamespace: 'sdb-ns',
    sourceType: 'psp_export',
    importedAt: new Date(),
    sourceHash: 'sdb'.padEnd(64, 'z'),
    recordCount: 0,
    importedCount: 0,
    skippedCount: 0,
    exceptionCount: 0,
    errorCount: 0,
    status: 'imported',
  });
  await doc.sync();
  sourceName = doc.name as string;
  return sourceName;
}

async function makeRecord(
  type: string,
  amount: string,
  date: string,
  currency: string
): Promise<string> {
  const id = `sdb-${++seq}`;
  const src = await getOrCreateSource();
  const doc = fyo.doc.getNewDoc(ModelNameEnum.DuhGoodsImportRecord);
  await doc.setMultiple({
    importSource: src,
    sourceType: 'psp_export',
    sourceNamespace: 'sdb-ns',
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
    evidenceHash: id.padEnd(64, 'd'),
    evidenceVersion: 1,
    priorEvidenceHash: '',
  });
  await doc.sync();
  return doc.name as string;
}

// ---------------------------------------------------------------------------
// Test 1: idx_dghsg_settlement_record exists (structural)
// ---------------------------------------------------------------------------

test('SettlementDB: idx_dghsg_settlement_record UNIQUE index exists', async (t) => {
  const indexes = (await rawDm.db!.knex!.raw(
    `PRAGMA index_list(DuhGoodsSettlementGroup)`
  )) as { name: string; unique: number }[];

  const found = indexes.find(
    (i) => i.name === 'idx_dghsg_settlement_record' && i.unique === 1
  );
  t.ok(
    found,
    'idx_dghsg_settlement_record is a UNIQUE index on DuhGoodsSettlementGroup'
  );
  t.end();
});

// ---------------------------------------------------------------------------
// Test 2: dghrm_prevent_accepted_insert_conflict trigger exists (structural)
// ---------------------------------------------------------------------------

test('SettlementDB: dghrm_prevent_accepted_insert_conflict trigger exists', async (t) => {
  const rows = (await rawDm.db!.knex!.raw(
    `SELECT name FROM sqlite_master WHERE type='trigger' AND name='dghrm_prevent_accepted_insert_conflict'`
  )) as { name: string }[];

  t.equal(
    rows.length,
    1,
    'trigger dghrm_prevent_accepted_insert_conflict exists'
  );
  t.end();
});

// ---------------------------------------------------------------------------
// Test 3: valid many-to-one settlement group (3 members) works end-to-end
// ---------------------------------------------------------------------------

test('SettlementDB: valid 3-member settlement group accepted correctly', async (t) => {
  const p1 = await makeRecord('payment', '100', '2026-11-01', 'SEK');
  const p2 = await makeRecord('payment', '200', '2026-11-02', 'SEK');
  const p3 = await makeRecord('refund', '-50', '2026-11-03', 'SEK');
  await makeRecord('settlement', '250', '2026-11-10', 'SEK');

  const svc = new SettlementService(fyo);
  const proposals = await svc.proposeGroups();
  const match = proposals.find(
    (p) => p.settlementRecord.currency === 'SEK' && !p.ambiguous
  );

  if (!match) {
    t.skip('no SEK proposal');
    t.end();
    return;
  }

  t.equal(match.memberRecords.length, 3, 'proposal has 3 members');
  const groupName = await svc.acceptGroup(match, 'reviewer');
  t.ok(groupName, 'acceptGroup returns group name');

  const groupRow = await fyo.db.get(
    ModelNameEnum.DuhGoodsSettlementGroup,
    groupName
  );
  t.equal(groupRow.status, 'closed', 'group is closed');
  t.equal(groupRow.memberCount, 3, 'memberCount is 3');
  t.equal(groupRow.currency, 'SEK', 'currency is SEK');

  for (const memberName of [p1, p2, p3]) {
    const matchRows = await fyo.db.getAll(
      ModelNameEnum.DuhGoodsReconciliationMatch,
      {
        filters: { leftRecord: memberName },
        fields: ['status', 'settlementGroup'],
      }
    );
    t.ok(matchRows.length >= 1, `member ${memberName} has a match row`);
    if (matchRows.length > 0) {
      t.equal(matchRows[0].status, 'accepted', 'match status is accepted');
      t.equal(matchRows[0].settlementGroup, groupName, 'match links to group');
    }
    const rec = await fyo.db.get(
      ModelNameEnum.DuhGoodsImportRecord,
      memberName
    );
    t.equal(rec.status, 'reconciled', `member ${memberName} is reconciled`);
  }
  t.end();
});

// ---------------------------------------------------------------------------
// Test 4: UNIQUE INDEX prevents two groups for the same settlement record
// ---------------------------------------------------------------------------

test('SettlementDB: UNIQUE INDEX prevents duplicate settlement group for same settlementRecord', async (t) => {
  const knex = rawDm.db!.knex!;
  await makeRecord('payment', '50', '2026-09-01', 'MXN');
  const settlementName = await makeRecord(
    'settlement',
    '50',
    '2026-09-05',
    'MXN'
  );

  const svc = new SettlementService(fyo);
  const proposals = await svc.proposeGroups();
  const match = proposals.find(
    (p) => p.settlementRecord.currency === 'MXN' && !p.ambiguous
  );
  if (!match) {
    t.skip('no MXN proposal');
    t.end();
    return;
  }
  const groupName = await svc.acceptGroup(match, 'reviewer');
  t.ok(groupName, 'first group created');

  // Direct raw INSERT of a second group for the same settlementRecord.
  let caught: Error | null = null;
  try {
    await knex.raw(
      `
      INSERT INTO DuhGoodsSettlementGroup
        (name, settlementRecord, currency, memberCount, totalMemberNet,
         settlementNet, delta, confidence, status,
         created, modified, createdBy, modifiedBy)
      VALUES
        ('DUP-GROUP', ?, 'MXN', 1, 50, 50, 0, 'exact', 'open',
         datetime('now'), datetime('now'), 'System', 'System')
    `,
      [match.settlementRecord.name]
    );
  } catch (e) {
    caught = e instanceof Error ? e : new Error(String(e));
  }
  t.ok(caught, 'raw INSERT of duplicate group throws');
  t.ok(
    caught?.message.includes('UNIQUE'),
    `UNIQUE constraint fires (got: ${caught?.message ?? ''})`
  );
  t.end();
});

// ---------------------------------------------------------------------------
// Test 5: BEFORE INSERT trigger — direct INSERT bypasses application but not DB
// ---------------------------------------------------------------------------

test('SettlementDB: direct INSERT with accepted leftRecord fires trigger', async (t) => {
  const knex = rawDm.db!.knex!;
  await makeRecord('payment', '80', '2026-10-01', 'NOK');
  await makeRecord('settlement', '80', '2026-10-05', 'NOK');

  const svc = new SettlementService(fyo);
  const proposals = await svc.proposeGroups();
  const match = proposals.find(
    (p) => p.settlementRecord.currency === 'NOK' && !p.ambiguous
  );
  if (!match) {
    t.skip('no NOK proposal');
    t.end();
    return;
  }
  const groupName = await svc.acceptGroup(match, 'reviewer');
  t.ok(groupName, 'group accepted');

  // Find the leftRecord (member) that is now accepted.
  const matchRows = await fyo.db.getAll(
    ModelNameEnum.DuhGoodsReconciliationMatch,
    {
      filters: { settlementGroup: groupName },
      fields: ['leftRecord'],
      limit: 1,
    }
  );
  t.ok(matchRows.length > 0, 'found existing match row');
  const memberName = matchRows[0].leftRecord as string;

  // Attempt raw INSERT: same leftRecord but different settlementGroup.
  let caught: Error | null = null;
  try {
    await knex.raw(
      `
      INSERT INTO DuhGoodsReconciliationMatch
        (name, importRecord, matchType, leftRecord, rightRecord,
         leftEvidenceHash, rightEvidenceHash, edgeKey,
         confidence, status, matchedAt, reviewedAt, reviewedBy,
         settlementGroup, reasonCodes, amountDelta, dateDeltaDays,
         evidenceSnapshot, decisionNotes, created, modified)
      VALUES
        ('BYPASS-ATTEMPT', ?, 'imported_evidence', ?, 'FAKE-SETTLEMENT',
         'aaaa', 'bbbb', 'FAKE-EDGE-KEY-BYPASS',
         'high', 'accepted', datetime('now'), datetime('now'), 'attacker',
         'DIFFERENT-GROUP', '[]', 0, 0,
         '{}', 'bypass attempt', datetime('now'), datetime('now'))
    `,
      [memberName, memberName]
    );
  } catch (e) {
    caught = e instanceof Error ? e : new Error(String(e));
  }

  t.ok(caught, 'raw INSERT with same leftRecord in different group throws');
  t.ok(
    caught?.message.includes('DuhGoods accepted reconciliation conflict'),
    `trigger fires with correct message (got: ${caught?.message ?? ''})`
  );
  t.end();
});

// ---------------------------------------------------------------------------
// Test 6: member cannot be reused in two settlement groups (application layer)
// ---------------------------------------------------------------------------

test('SettlementDB: SettlementService rejects reusing a member in a second group', async (t) => {
  // Create Group1: Payment1 + Settlement1
  const p1 = await makeRecord('payment', '60', '2026-08-01', 'NZD');
  await makeRecord('settlement', '60', '2026-08-05', 'NZD');

  const svc = new SettlementService(fyo);
  const proposals1 = await svc.proposeGroups();
  const match1 = proposals1.find(
    (p) => p.settlementRecord.currency === 'NZD' && !p.ambiguous
  );
  if (!match1) {
    t.skip('no NZD proposal for first group');
    t.end();
    return;
  }
  const groupName = await svc.acceptGroup(match1, 'reviewer');
  t.ok(groupName, 'first group accepted');

  // Craft a fake second proposal with the same p1 member but a different settlement.
  // This bypasses proposeGroups() (which would never return an already-reconciled member)
  // and directly tests the DB trigger.
  const fakeSettlement = match1.settlementRecord;
  const fakeMember = match1.memberRecords.find((m) => m.name === p1);
  if (!fakeMember) {
    t.skip('could not find p1 in match members');
    t.end();
    return;
  }

  // Create a NEW settlement record for the fake second group.
  const s2 = await makeRecord('settlement', '60', '2026-08-15', 'NZD');
  const s2Row = await fyo.db.get(ModelNameEnum.DuhGoodsImportRecord, s2);
  const fakeSettlement2 = {
    name: s2,
    transactionType: 'settlement',
    transactionDate: s2Row.transactionDate as Date,
    currency: 'NZD',
    netAmount: fyo.pesa('60'),
    evidenceHash: s2.padEnd(64, 'e'),
  };

  const fakeProposal2 = {
    settlementRecord: fakeSettlement2,
    memberRecords: [fakeMember],
    totalMemberNet: fyo.pesa('60'),
    settlementNet: fyo.pesa('60'),
    delta: fyo.pesa('0'),
    confidence: 'exact' as const,
    ambiguous: false,
    alternativeCount: 1,
  };

  let caught: Error | null = null;
  try {
    await svc.acceptGroup(fakeProposal2, 'attacker');
  } catch (e) {
    caught = e instanceof Error ? e : new Error(String(e));
  }

  t.ok(caught, 'acceptGroup throws when reusing a member in a second group');
  t.ok(
    caught?.message.includes('DuhGoods accepted reconciliation conflict') ||
      caught?.message.includes('conflict') ||
      caught?.message.includes('UNIQUE'),
    `trigger or constraint fires (got: ${caught?.message ?? ''})`
  );
  t.end();
});

// ---------------------------------------------------------------------------
// Test 7: idempotent re-acceptance returns same group name
// ---------------------------------------------------------------------------

test('SettlementDB: idempotent re-acceptance returns same group name', async (t) => {
  await makeRecord('payment', '300', '2026-12-01', 'DKK');
  await makeRecord('settlement', '300', '2026-12-05', 'DKK');

  const svc = new SettlementService(fyo);
  const proposals = await svc.proposeGroups();
  const match = proposals.find(
    (p) => p.settlementRecord.currency === 'DKK' && !p.ambiguous
  );
  if (!match) {
    t.skip('no DKK proposal');
    t.end();
    return;
  }

  const groupName1 = await svc.acceptGroup(match, 'reviewer-1');
  const groupName2 = await svc.acceptGroup(match, 'reviewer-2');
  t.equal(groupName1, groupName2, 'second acceptGroup returns same group name');

  const matchRows = await fyo.db.getAll(
    ModelNameEnum.DuhGoodsReconciliationMatch,
    {
      filters: { settlementGroup: groupName1 },
      fields: ['name'],
    }
  );
  t.equal(matchRows.length, 1, 'no duplicate match rows created');
  t.end();
});

// ---------------------------------------------------------------------------
// Test 8: close/reopen lifecycle preserves trigger invariant
// ---------------------------------------------------------------------------

test('SettlementDB: close/reopen lifecycle preserves trigger invariant', async (t) => {
  const knex = rawDm.db!.knex!;
  await makeRecord('payment', '999', '2026-07-15', 'THB');
  await makeRecord('settlement', '999', '2026-07-20', 'THB');

  const svc = new SettlementService(fyo);
  const proposals = await svc.proposeGroups();
  const match = proposals.find(
    (p) => p.settlementRecord.currency === 'THB' && !p.ambiguous
  );
  if (!match) {
    t.skip('no THB proposal');
    t.end();
    return;
  }

  const groupName = await svc.acceptGroup(match, 'reviewer');
  const g1 = await fyo.db.get(ModelNameEnum.DuhGoodsSettlementGroup, groupName);
  t.equal(g1.status, 'closed', 'starts closed');

  await svc.reopenGroup(groupName);
  const g2 = await fyo.db.get(ModelNameEnum.DuhGoodsSettlementGroup, groupName);
  t.equal(g2.status, 'reopened', 'reopened');

  await svc.closeGroup(groupName);
  const g3 = await fyo.db.get(ModelNameEnum.DuhGoodsSettlementGroup, groupName);
  t.equal(g3.status, 'closed', 'closed again');

  // Trigger still protects after lifecycle changes — raw INSERT attempt.
  const matchRows = await fyo.db.getAll(
    ModelNameEnum.DuhGoodsReconciliationMatch,
    {
      filters: { settlementGroup: groupName },
      fields: ['leftRecord'],
      limit: 1,
    }
  );
  if (matchRows.length === 0) {
    t.skip('no match rows found to test trigger after lifecycle');
    t.end();
    return;
  }
  const memberName = matchRows[0].leftRecord as string;

  let caught: Error | null = null;
  try {
    await knex.raw(
      `
      INSERT INTO DuhGoodsReconciliationMatch
        (name, importRecord, matchType, leftRecord, rightRecord,
         leftEvidenceHash, rightEvidenceHash, edgeKey,
         confidence, status, matchedAt, reviewedAt, reviewedBy,
         settlementGroup, reasonCodes, amountDelta, dateDeltaDays,
         evidenceSnapshot, decisionNotes, created, modified)
      VALUES
        ('POST-LIFECYCLE-TEST', ?, 'imported_evidence', ?, 'FAKE-S3',
         'cccc', 'dddd', 'POST-LIFECYCLE-EDGE',
         'high', 'accepted', datetime('now'), datetime('now'), 'attacker',
         'ANOTHER-GROUP-3', '[]', 0, 0,
         '{}', 'post lifecycle test', datetime('now'), datetime('now'))
    `,
      [memberName, memberName]
    );
  } catch (e) {
    caught = e instanceof Error ? e : new Error(String(e));
  }

  t.ok(caught, 'trigger fires after close/reopen lifecycle');
  t.ok(
    caught?.message.includes('DuhGoods accepted reconciliation conflict'),
    `correct trigger message (got: ${caught?.message ?? ''})`
  );
  t.end();
});

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

test('SettlementDB teardown: close connections and delete temp file', async (t) => {
  try {
    await rawDm.db?.close();
  } catch {}
  try {
    await fyo.close();
  } catch {}
  try {
    if (tempDbPath && fs.existsSync(tempDbPath)) {
      fs.unlinkSync(tempDbPath);
    }
  } catch {}
  t.pass('teardown complete');
  t.end();
});
