/**
 * DuhGoods file-backed migration integration test.
 *
 * Unlike testDuhGoodsMigration.spec.ts (in-memory only), this test uses a
 * REAL temporary file-backed SQLite database to prove:
 *
 *   1. Pre-DuhGoods accounting data can be seeded before migration.
 *   2. Running setupInstance runs the full migration lifecycle (patches +
 *      schema-sync), creating DuhGoods tables.
 *   3. The real SQLite UNIQUE indexes (idx_dghir_evidence_hash,
 *      idx_dghir_identity_version) exist and are enforced by the DB engine
 *      INDEPENDENT of the application-layer beforeSync() check.
 *   4. Existing accounting data survives migration.
 *   5. Closing and reopening the database file preserves all data and schema.
 *   6. Re-running migration (idempotency) does NOT destroy data or schema.
 *   7. The temporary file is deleted during test cleanup.
 *
 * Direct-DB uniqueness proof: the concurrency test bypasses Doc.beforeSync()
 * entirely and inserts via raw Knex, confirming the SQLite index itself is
 * the atomic barrier — not the application-layer check.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import test from 'tape';
import { DatabaseManager } from 'backend/database/manager';
import { Fyo } from 'fyo';
import { DummyAuthDemux } from 'fyo/tests/helpers';
import setupInstance from 'src/setup/setupInstance';
import { getSchemas } from 'schemas';
import { getTestSetupWizardOptions, getTestDbPath } from './helpers';

let tempDbPath: string;
let rawDm: DatabaseManager; // direct DatabaseManager for PRAGMA access

// ---------- helpers ----------------------------------------------------------

function makeTempDbPath(): string {
  return path.join(os.tmpdir(), `duhgoods-fb-migration-${Date.now()}.db`);
}

function makeFyo() {
  return new Fyo({
    DatabaseDemux: DatabaseManager,
    AuthDemux: DummyAuthDemux,
    isTest: true,
    isElectron: false,
  });
}

/** Run PRAGMA index_list on a table and return the list of indexes. */
async function getIndexList(
  dm: DatabaseManager,
  tableName: string
): Promise<{ name: string; unique: number }[]> {
  const rows = (await dm.db!.knex!.raw(`PRAGMA index_list(${tableName})`)) as {
    name: string;
    unique: number;
  }[];
  return Array.isArray(rows) ? rows : [];
}

/** Return column names for a table via PRAGMA table_info. */
async function getTableColumns(
  dm: DatabaseManager,
  tableName: string
): Promise<string[]> {
  const rows = (await dm.db!.knex!.raw(`PRAGMA table_info(${tableName})`)) as {
    name: string;
  }[];
  return Array.isArray(rows) ? rows.map((r) => r.name) : [];
}

// ---------- setup: use Fyo / setupInstance to bootstrap the DB ---------------

test('file-backed setup: create temp DB via setupInstance', async (t) => {
  tempDbPath = makeTempDbPath();

  // Use a full Fyo + setupInstance to create the file-backed DB exactly as
  // production does (runs all patches, schema-sync, seed data).
  const fyo = makeFyo();
  const options = getTestSetupWizardOptions();
  await setupInstance(tempDbPath, options, fyo);

  // Verify accounting seed data exists (Currency is created during setup).
  const currencies = await fyo.db.getAll('Currency', {
    fields: ['name'],
    limit: 3,
  });
  t.ok(
    currencies.length > 0,
    `setup seeded Currency records (${currencies.length})`
  );

  const accounts = await fyo.db.getAll('Account', {
    fields: ['name'],
    limit: 3,
  });
  t.ok(
    accounts.length > 0,
    `setup seeded Account records (${accounts.length})`
  );

  await fyo.close();
  t.ok(fs.existsSync(tempDbPath), 'temp DB file exists on disk after close');
  t.end();
});

// ---------- reopen with raw DatabaseManager ----------------------------------

test('file-backed: reopen DB with raw DatabaseManager for direct PRAGMA access', async (t) => {
  rawDm = new DatabaseManager();
  // connectToDatabase runs migrate() internally (idempotent on reopened DB).
  const cc = await rawDm.connectToDatabase(tempDbPath);
  t.ok(cc, `connected — countryCode: ${cc}`);
  t.ok(rawDm.db?.knex, 'raw DatabaseManager.db.knex is accessible');
  t.end();
});

// ---------- table column existence -------------------------------------------

test('file-backed: DuhGoodsImportSource has all Round-3 columns', async (t) => {
  const cols = await getTableColumns(rawDm, 'DuhGoodsImportSource');
  const required = [
    'name',
    'sourceName',
    'sourceNamespace',
    'sourceType',
    'importedAt',
    'sourceFile',
    'sourceHash',
    'recordCount',
    'importedCount',
    'skippedCount',
    'exceptionCount',
    'errorCount',
    'status',
    'errorSummary',
  ];
  for (const col of required) {
    t.ok(cols.includes(col), `DuhGoodsImportSource.${col} exists`);
  }
  t.end();
});

test('file-backed: DuhGoodsImportRecord has all Round-3 columns', async (t) => {
  const cols = await getTableColumns(rawDm, 'DuhGoodsImportRecord');
  const required = [
    'name',
    'importSource',
    'sourceType',
    'sourceNamespace',
    'sourceId',
    'identityKey',
    'rowLocator',
    'transactionType',
    'transactionDate',
    'currency',
    'grossAmount',
    'fees',
    'taxes',
    'netAmount',
    'status',
    'rawData',
    'evidenceHash',
    'evidenceVersion',
    'priorEvidenceHash',
    'notes',
  ];
  for (const col of required) {
    t.ok(cols.includes(col), `DuhGoodsImportRecord.${col} exists`);
  }
  t.end();
});

// ---------- real UNIQUE INDEX existence via PRAGMA ---------------------------

test('file-backed: real SQLite UNIQUE indexes exist on DuhGoodsImportRecord', async (t) => {
  const indexes = await getIndexList(rawDm, 'DuhGoodsImportRecord');

  t.ok(
    indexes.length > 0,
    `at least one index exists (found ${indexes.length})`
  );

  const evidenceHashIdx = indexes.find(
    (i) => i.name === 'idx_dghir_evidence_hash'
  );
  t.ok(evidenceHashIdx, 'idx_dghir_evidence_hash index exists');
  t.equal(
    Number(evidenceHashIdx?.unique),
    1,
    'idx_dghir_evidence_hash is UNIQUE=1'
  );

  const identityVersionIdx = indexes.find(
    (i) => i.name === 'idx_dghir_identity_version'
  );
  t.ok(identityVersionIdx, 'idx_dghir_identity_version index exists');
  t.equal(
    Number(identityVersionIdx?.unique),
    1,
    'idx_dghir_identity_version is UNIQUE=1'
  );

  t.end();
});

// ---------- direct-DB concurrency test — bypasses beforeSync() ---------------

test('file-backed: SQLite UNIQUE INDEX rejects duplicate evidenceHash without beforeSync()', async (t) => {
  const knex = rawDm.db!.knex!;
  const now = new Date().toISOString();

  // Insert a parent ImportSource row to satisfy the importSource FK constraint.
  const srcRow = {
    name: 'fb-src-direct',
    created: now,
    modified: now,
    createdBy: '__SYSTEM__',
    modifiedBy: '__SYSTEM__',
    sourceName: 'Direct-DB Test Source',
    sourceNamespace: 'bank:FB:DIRECT',
    sourceType: 'bank_statement',
    importedAt: now,
    sourceFile: '',
    sourceHash: '0'.repeat(64),
    recordCount: 1,
    importedCount: 0,
    skippedCount: 0,
    exceptionCount: 0,
    errorCount: 0,
    status: 'pending',
    errorSummary: null,
  };
  await knex('DuhGoodsImportSource').insert(srcRow);

  const baseRow = {
    name: 'fb-direct-1',
    created: now,
    modified: now,
    createdBy: '__SYSTEM__',
    modifiedBy: '__SYSTEM__',
    importSource: 'fb-src-direct',
    sourceType: 'bank_statement',
    sourceNamespace: 'bank:FB:DIRECT',
    sourceId: 'FB-REF-001',
    identityKey: 'd'.repeat(64),
    rowLocator: 0,
    transactionType: 'bank_credit',
    transactionDate: now,
    currency: 'SAR',
    grossAmount: '500.0',
    fees: '0.0',
    taxes: '0.0',
    netAmount: '500.0',
    status: 'pending',
    rawData: '{"ref":"FB-REF-001"}',
    evidenceHash: 'e'.repeat(64),
    evidenceVersion: 1,
    priorEvidenceHash: '',
    notes: null,
  };

  // First insert — must succeed.
  await knex('DuhGoodsImportRecord').insert(baseRow);
  t.pass('first direct-DB insert succeeded');

  // Second insert — same evidenceHash but different identityKey so only the
  // evidenceHash UNIQUE index fires (not the composite index).
  let uniqueErr: Error | null = null;
  try {
    await knex('DuhGoodsImportRecord').insert({
      ...baseRow,
      name: 'fb-direct-2',
      identityKey: 'g'.repeat(64), // different identity → only evidenceHash collides
    });
  } catch (err) {
    uniqueErr = err instanceof Error ? err : new Error(String(err));
  }

  t.ok(uniqueErr, 'duplicate evidenceHash rejected by SQLite UNIQUE INDEX');
  t.ok(
    /UNIQUE constraint failed.*DuhGoodsImportRecord.*evidenceHash/i.test(
      uniqueErr?.message ?? ''
    ),
    `UNIQUE INDEX error message (got: "${uniqueErr?.message ?? '(none)'}")`
  );

  // (identityKey, evidenceVersion) composite uniqueness.
  let compositeErr: Error | null = null;
  try {
    await knex('DuhGoodsImportRecord').insert({
      ...baseRow,
      name: 'fb-direct-3',
      evidenceHash: 'f'.repeat(64), // different hash — bypasses evidenceHash index
      // identityKey + evidenceVersion same as baseRow
    });
  } catch (err) {
    compositeErr = err instanceof Error ? err : new Error(String(err));
  }

  t.ok(
    compositeErr,
    'duplicate (identityKey, evidenceVersion) rejected by SQLite'
  );
  t.ok(
    /UNIQUE constraint failed.*DuhGoodsImportRecord/i.test(
      compositeErr?.message ?? ''
    ),
    `composite UNIQUE INDEX error (got: "${compositeErr?.message ?? '(none)'}")`
  );

  t.end();
});

// ---------- close and reopen: data and schema survive ------------------------

test('file-backed: close raw DatabaseManager', async (t) => {
  await rawDm.db!.close();
  t.pass('raw DatabaseManager closed');
  t.end();
});

test('file-backed: reopen — all data and indexes survive close+reopen', async (t) => {
  rawDm = new DatabaseManager();
  await rawDm.connectToDatabase(tempDbPath);
  t.ok(rawDm.db?.knex, 'DB reconnected');

  // Indexes survive.
  const indexes = await getIndexList(rawDm, 'DuhGoodsImportRecord');
  const evidenceHashIdx = indexes.find(
    (i) => i.name === 'idx_dghir_evidence_hash'
  );
  t.ok(
    evidenceHashIdx && Number(evidenceHashIdx.unique) === 1,
    'idx_dghir_evidence_hash survives close+reopen'
  );

  // Direct-inserted record survives.
  const rows = await rawDm.db!.knex!('DuhGoodsImportRecord').where({
    name: 'fb-direct-1',
  });
  t.equal(rows.length, 1, 'direct-inserted record survives close+reopen');

  t.end();
});

test('file-backed: idempotency — second migrate() run preserves data and schema', async (t) => {
  // Call migrate() a second time; must be safe (IF NOT EXISTS on indexes).
  await rawDm.db!.migrate();

  const indexes = await getIndexList(rawDm, 'DuhGoodsImportRecord');
  const evidenceHashIdx = indexes.find(
    (i) => i.name === 'idx_dghir_evidence_hash'
  );
  t.ok(
    evidenceHashIdx && Number(evidenceHashIdx.unique) === 1,
    'idx_dghir_evidence_hash intact after second migrate()'
  );

  const rows = await rawDm.db!.knex!('DuhGoodsImportRecord').where({
    name: 'fb-direct-1',
  });
  t.equal(rows.length, 1, 'data intact after idempotent second migrate()');

  t.end();
});

// ---------- cleanup ----------------------------------------------------------

test('file-backed cleanup: delete temp file', async (t) => {
  try {
    await rawDm.db!.close();
  } catch {
    // ignore
  }

  if (fs.existsSync(tempDbPath)) {
    fs.unlinkSync(tempDbPath);
    t.notOk(fs.existsSync(tempDbPath), 'temp DB file deleted');
  } else {
    t.pass('temp DB file already absent');
  }

  for (const suffix of ['-wal', '-shm']) {
    const journal = tempDbPath + suffix;
    if (fs.existsSync(journal)) fs.unlinkSync(journal);
  }

  t.end();
});

// =============================================================================
// Pre-DuhGoods upgrade simulation
//
// Proves that an existing DB (with accounting data but WITHOUT DuhGoods tables)
// is correctly upgraded to include DuhGoods tables, columns, and UNIQUE indexes
// without disturbing the pre-existing accounting data.
//
// Method:
//   1. Create a fresh DB via setupInstance (includes DuhGoods from the start).
//   2. Simulate "pre-DuhGoods state": drop the three DuhGoods tables and remove
//      their PatchRun entries so the migrator treats them as unexecuted patches.
//   3. Verify accounting data (Currency, Account) still exists and DuhGoods
//      tables are gone.
//   4. Close and reopen via a fresh DatabaseManager.connectToDatabase() — this
//      runs the full migration lifecycle, recreating DuhGoods tables and indexes.
//   5. Assert: accounting data survived, DuhGoods tables exist with all columns,
//      UNIQUE indexes are present, PatchRun records the two DuhGoods patches,
//      close+reopen preserves everything, second migrate() is idempotent.
// =============================================================================

let upgradeTempDbPath: string;
let upgradeDm: DatabaseManager;

test('upgrade-sim setup: create full DB via setupInstance', async (t) => {
  upgradeTempDbPath = path.join(os.tmpdir(), `dghir-upgrade-${Date.now()}.db`);

  const fyo = makeFyo();
  const options = getTestSetupWizardOptions();
  await setupInstance(upgradeTempDbPath, options, fyo);

  const currencies = await fyo.db.getAll('Currency', {
    fields: ['name'],
    limit: 3,
  });
  t.ok(
    currencies.length > 0,
    `seed: Currency records present (${currencies.length})`
  );
  const accounts = await fyo.db.getAll('Account', {
    fields: ['name'],
    limit: 3,
  });
  t.ok(
    accounts.length > 0,
    `seed: Account records present (${accounts.length})`
  );

  await fyo.close();
  t.ok(fs.existsSync(upgradeTempDbPath), 'DB file on disk after close');
  t.end();
});

test('upgrade-sim: simulate pre-DuhGoods state (drop tables + erase PatchRun entries)', async (t) => {
  const dm = new DatabaseManager();
  await dm.connectToDatabase(upgradeTempDbPath);
  const knex = dm.db!.knex!;

  // Drop DuhGoods tables in FK-safe order.
  await knex.raw('DROP TABLE IF EXISTS DuhGoodsImportRecord');
  await knex.raw('DROP TABLE IF EXISTS DuhGoodsReconciliationMatch');
  await knex.raw('DROP TABLE IF EXISTS DuhGoodsImportSource');

  t.pass('DuhGoods tables dropped');

  // Remove PatchRun entries for both DuhGoods patches so the migrator
  // re-runs them on next connectToDatabase.
  await knex('PatchRun')
    .whereIn('name', ['createDuhGoodsTables', 'createDuhGoodsEvidenceIndex'])
    .delete();

  const remaining = await knex('PatchRun')
    .whereIn('name', ['createDuhGoodsTables', 'createDuhGoodsEvidenceIndex'])
    .count('* as cnt');
  t.equal(
    Number((remaining[0] as { cnt: number }).cnt),
    0,
    'DuhGoods PatchRun entries removed'
  );

  // Accounting data must still exist.
  const currRows = (await knex('Currency').count('* as cnt')) as {
    cnt: number;
  }[];
  t.ok(
    Number(currRows[0].cnt) > 0,
    'Currency rows survive pre-DuhGoods simulation'
  );
  const acctRows = (await knex('Account').count('* as cnt')) as {
    cnt: number;
  }[];
  t.ok(
    Number(acctRows[0].cnt) > 0,
    'Account rows survive pre-DuhGoods simulation'
  );

  // DuhGoods tables must be gone.
  const dghirRow = (await knex('sqlite_master').where({
    type: 'table',
    name: 'DuhGoodsImportRecord',
  })) as unknown[];
  t.equal(dghirRow.length, 0, 'DuhGoodsImportRecord absent after simulation');

  await dm.db!.close();
  t.end();
});

test('upgrade-sim: reopen DB — migration lifecycle recreates DuhGoods tables', async (t) => {
  upgradeDm = new DatabaseManager();
  // connectToDatabase runs #migrate() which detects the missing PatchRun entries
  // and re-runs createDuhGoodsTables + createDuhGoodsEvidenceIndex.
  await upgradeDm.connectToDatabase(upgradeTempDbPath);
  t.ok(upgradeDm.db?.knex, 'DB reconnected');
  t.end();
});

test('upgrade-sim: accounting data survived migration', async (t) => {
  const currRows = (await upgradeDm.db!.knex!('Currency').count(
    '* as cnt'
  )) as { cnt: number }[];
  t.ok(Number(currRows[0].cnt) > 0, 'Currency rows survive migration');
  const acctRows = (await upgradeDm.db!.knex!('Account').count('* as cnt')) as {
    cnt: number;
  }[];
  t.ok(Number(acctRows[0].cnt) > 0, 'Account rows survive migration');
  t.end();
});

test('upgrade-sim: DuhGoodsImportSource has all required columns', async (t) => {
  const cols = await getTableColumns(upgradeDm, 'DuhGoodsImportSource');
  for (const col of [
    'name',
    'sourceName',
    'sourceNamespace',
    'sourceType',
    'importedAt',
    'sourceFile',
    'sourceHash',
    'recordCount',
    'importedCount',
    'skippedCount',
    'exceptionCount',
    'errorCount',
    'status',
    'errorSummary',
  ]) {
    t.ok(cols.includes(col), `DuhGoodsImportSource.${col} present`);
  }
  t.end();
});

test('upgrade-sim: DuhGoodsImportRecord has all required columns', async (t) => {
  const cols = await getTableColumns(upgradeDm, 'DuhGoodsImportRecord');
  for (const col of [
    'name',
    'importSource',
    'sourceType',
    'sourceNamespace',
    'sourceId',
    'identityKey',
    'rowLocator',
    'transactionType',
    'transactionDate',
    'currency',
    'grossAmount',
    'fees',
    'taxes',
    'netAmount',
    'status',
    'rawData',
    'evidenceHash',
    'evidenceVersion',
    'priorEvidenceHash',
    'notes',
  ]) {
    t.ok(cols.includes(col), `DuhGoodsImportRecord.${col} present`);
  }
  t.end();
});

test('upgrade-sim: UNIQUE indexes exist after migration', async (t) => {
  const indexes = await getIndexList(upgradeDm, 'DuhGoodsImportRecord');
  const ehIdx = indexes.find((i) => i.name === 'idx_dghir_evidence_hash');
  t.ok(ehIdx, 'idx_dghir_evidence_hash present');
  t.equal(Number(ehIdx?.unique), 1, 'idx_dghir_evidence_hash is UNIQUE');
  const ivIdx = indexes.find((i) => i.name === 'idx_dghir_identity_version');
  t.ok(ivIdx, 'idx_dghir_identity_version present');
  t.equal(Number(ivIdx?.unique), 1, 'idx_dghir_identity_version is UNIQUE');
  t.end();
});

test('upgrade-sim: PatchRun records both DuhGoods patches after migration', async (t) => {
  const rows = (await upgradeDm.db!.knex!('PatchRun')
    .whereIn('name', ['createDuhGoodsTables', 'createDuhGoodsEvidenceIndex'])
    .select('name', 'failed')) as { name: string; failed: boolean | number }[];

  t.equal(rows.length, 2, 'both DuhGoods patches recorded in PatchRun');
  for (const row of rows) {
    t.notOk(row.failed, `patch "${row.name}" did not fail`);
  }
  t.end();
});

test('upgrade-sim: close and reopen — data and indexes survive', async (t) => {
  await upgradeDm.db!.close();
  upgradeDm = new DatabaseManager();
  await upgradeDm.connectToDatabase(upgradeTempDbPath);
  t.ok(upgradeDm.db?.knex, 'DB reconnected');

  const indexes = await getIndexList(upgradeDm, 'DuhGoodsImportRecord');
  t.ok(
    indexes.find((i) => i.name === 'idx_dghir_evidence_hash'),
    'idx_dghir_evidence_hash survives close+reopen'
  );

  const currRows = (await upgradeDm.db!.knex!('Currency').count(
    '* as cnt'
  )) as { cnt: number }[];
  t.ok(Number(currRows[0].cnt) > 0, 'Currency rows survive close+reopen');
  t.end();
});

test('upgrade-sim: idempotency — second migrate() does not destroy data or schema', async (t) => {
  await upgradeDm.db!.migrate();

  const indexes = await getIndexList(upgradeDm, 'DuhGoodsImportRecord');
  t.ok(
    indexes.find((i) => i.name === 'idx_dghir_evidence_hash'),
    'idx_dghir_evidence_hash intact after second migrate()'
  );
  const currRows = (await upgradeDm.db!.knex!('Currency').count(
    '* as cnt'
  )) as { cnt: number }[];
  t.ok(
    Number(currRows[0].cnt) > 0,
    'Currency rows intact after idempotent second migrate()'
  );
  t.end();
});

test('upgrade-sim cleanup: delete temp file', async (t) => {
  try {
    await upgradeDm.db!.close();
  } catch {
    // ignore
  }
  if (fs.existsSync(upgradeTempDbPath)) {
    fs.unlinkSync(upgradeTempDbPath);
    t.notOk(fs.existsSync(upgradeTempDbPath), 'upgrade-sim temp DB deleted');
  } else {
    t.pass('upgrade-sim temp DB already absent');
  }
  for (const suffix of ['-wal', '-shm']) {
    const j = upgradeTempDbPath + suffix;
    if (fs.existsSync(j)) fs.unlinkSync(j);
  }
  t.end();
});
