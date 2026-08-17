/**
 * Import profile integration tests.
 *
 * Proves that two saved DuhGoodsImportProfile records with completely
 * different file layouts can each import their own test files correctly
 * WITHOUT changing any code — only the profile's columnMappings and
 * parserOptions drive the parsing.
 *
 * Profile A — PSP export, JSON format, non-standard column names:
 *   { txn_id, txn_date, txn_type, ccy, amount_gross, amount_fee, amount_tax }
 *   typeMap: { payout → settlement }
 *
 * Profile B — Bank statement, CSV format, non-standard column names:
 *   Trans_Date, Debit_SAR, Credit_SAR, Ref_No
 *   defaultCurrency: SAR
 *
 * The DailyOrchestrator.runProfileImport() method loads the profile from DB
 * and delegates to ProfileDrivenImporter + ImportOrchestrator — no hardcoded
 * importer classes are involved.
 */

import test from 'tape';
import { ModelNameEnum } from 'models/types';
import { DailyOrchestrator } from '../duhgoods/daily/DailyOrchestrator';
import { closeTestFyo, getTestFyo, setupTestFyo } from './helpers';

const fyo = getTestFyo();
setupTestFyo(fyo, __filename);

// ─── Profile fixtures ────────────────────────────────────────────────────────

const PROFILE_A_MAPPINGS = JSON.stringify({
  id: 'txn_id',
  date: 'txn_date',
  type: 'txn_type',
  currency: 'ccy',
  gross: 'amount_gross',
  fee: 'amount_fee',
  tax: 'amount_tax',
});

const PROFILE_A_OPTIONS = JSON.stringify({
  typeMap: { payout: 'settlement' },
});

// PSP JSON file with non-standard column names.
const PROFILE_A_CONTENT = JSON.stringify([
  {
    txn_id: 'PSP-PROF-001',
    txn_date: '2026-03-10',
    txn_type: 'payment',
    ccy: 'SAR',
    amount_gross: '500.00',
    amount_fee: '12.50',
    amount_tax: '0',
  },
  {
    txn_id: 'PSP-PROF-002',
    txn_date: '2026-03-15',
    txn_type: 'payout', // mapped to 'settlement' via typeMap
    ccy: 'SAR',
    amount_gross: '487.50',
    amount_fee: '0',
    amount_tax: '0',
  },
]);

const PROFILE_B_MAPPINGS = JSON.stringify({
  date: 'Trans_Date',
  debit: 'Debit_SAR',
  credit: 'Credit_SAR',
  reference: 'Ref_No',
});

const PROFILE_B_OPTIONS = JSON.stringify({});

// Bank CSV file with non-standard column names.
const PROFILE_B_CONTENT = [
  'Trans_Date,Debit_SAR,Credit_SAR,Ref_No',
  '2026-04-01,0,1000.00,TXN-BANK-PROF-001',
  '2026-04-05,250.00,0,TXN-BANK-PROF-002',
].join('\n');

// ─── Setup: create two profiles ──────────────────────────────────────────────

let profileAName: string;
let profileBName: string;

test('ImportProfile: create Profile A (PSP JSON, custom column names)', async (t) => {
  const doc = fyo.doc.getNewDoc(ModelNameEnum.DuhGoodsImportProfile);
  await doc.setMultiple({
    profileName: 'Test PSP Profile A',
    sourceType: 'psp_export',
    fileFormat: 'json',
    defaultSourceNamespace: 'psp:profile-a-test',
    defaultCurrency: '',
    columnMappings: PROFILE_A_MAPPINGS,
    parserOptions: PROFILE_A_OPTIONS,
    notes: 'PSP profile with non-standard column names — test only',
  });
  await doc.sync();
  profileAName = doc.name as string;
  t.ok(profileAName, 'Profile A created with name');
  t.end();
});

test('ImportProfile: create Profile B (Bank CSV, custom column names)', async (t) => {
  const doc = fyo.doc.getNewDoc(ModelNameEnum.DuhGoodsImportProfile);
  await doc.setMultiple({
    profileName: 'Test Bank Profile B',
    sourceType: 'bank_statement',
    fileFormat: 'csv',
    defaultSourceNamespace: 'bank:profile-b-test',
    defaultCurrency: 'SAR',
    columnMappings: PROFILE_B_MAPPINGS,
    parserOptions: PROFILE_B_OPTIONS,
    notes: 'Bank CSV profile with non-standard column names — test only',
  });
  await doc.sync();
  profileBName = doc.name as string;
  t.ok(profileBName, 'Profile B created with name');
  t.end();
});

// ─── Import with Profile A ───────────────────────────────────────────────────

test('ImportProfile: Profile A imports PSP JSON (2 rows: payment + settlement)', async (t) => {
  const orch = new DailyOrchestrator(fyo);
  const result = await orch.runProfileImport(profileAName, PROFILE_A_CONTENT);

  t.equal(result.imported, 2, 'imported 2 records');
  t.equal(result.skipped, 0, 'no skips');
  t.equal(result.exceptions, 0, 'no exceptions');
  t.equal(
    result.errors.length,
    0,
    `no errors (got: ${JSON.stringify(result.errors)})`
  );
  t.equal(result.sourceLabel, profileAName, 'sourceLabel matches profile name');

  // Verify the imported records have the correct mapped fields
  const records = await fyo.db.getAll(ModelNameEnum.DuhGoodsImportRecord, {
    filters: { sourceNamespace: 'psp:profile-a-test' },
    fields: [
      'name',
      'sourceId',
      'transactionType',
      'currency',
      'grossAmount',
      'netAmount',
    ],
    orderBy: 'sourceId',
    order: 'asc',
  });

  t.equal(records.length, 2, '2 records in DB');

  const payment = records.find((r) => r.sourceId === 'PSP-PROF-001');
  t.ok(payment, 'PSP-PROF-001 record found');
  if (payment) {
    t.equal(payment.transactionType, 'payment', 'transactionType is payment');
    t.equal(payment.currency, 'SAR', 'currency is SAR');
    t.equal(String(payment.grossAmount), '500', 'grossAmount is 500');
    // net = gross - fee - tax = 500 - 12.5 - 0 = 487.5
    t.ok(String(payment.netAmount).startsWith('487.5'), 'netAmount is 487.5');
  }

  const settlement = records.find((r) => r.sourceId === 'PSP-PROF-002');
  t.ok(settlement, 'PSP-PROF-002 record found');
  if (settlement) {
    t.equal(
      settlement.transactionType,
      'settlement',
      'payout mapped to settlement'
    );
    t.equal(String(settlement.grossAmount), '487.5', 'grossAmount is 487.5');
  }

  t.end();
});

// ─── Import with Profile B ───────────────────────────────────────────────────

test('ImportProfile: Profile B imports Bank CSV (2 rows: credit + debit)', async (t) => {
  const orch = new DailyOrchestrator(fyo);
  const result = await orch.runProfileImport(profileBName, PROFILE_B_CONTENT);

  t.equal(result.imported, 2, 'imported 2 records');
  t.equal(result.skipped, 0, 'no skips');
  t.equal(result.exceptions, 0, 'no exceptions');
  t.equal(
    result.errors.length,
    0,
    `no errors (got: ${JSON.stringify(result.errors)})`
  );

  const records = await fyo.db.getAll(ModelNameEnum.DuhGoodsImportRecord, {
    filters: { sourceNamespace: 'bank:profile-b-test' },
    fields: [
      'name',
      'sourceId',
      'transactionType',
      'currency',
      'grossAmount',
      'netAmount',
    ],
    orderBy: 'sourceId',
    order: 'asc',
  });

  t.equal(records.length, 2, '2 records in DB');

  const credit = records.find((r) => r.sourceId === 'TXN-BANK-PROF-001');
  t.ok(credit, 'TXN-BANK-PROF-001 found');
  if (credit) {
    t.equal(credit.transactionType, 'bank_credit', 'credit row is bank_credit');
    t.equal(credit.currency, 'SAR', 'currency from defaultCurrency');
    t.equal(String(credit.grossAmount), '1000', 'grossAmount is 1000');
    t.equal(String(credit.netAmount), '1000', 'netAmount is 1000 (credit)');
  }

  const debit = records.find((r) => r.sourceId === 'TXN-BANK-PROF-002');
  t.ok(debit, 'TXN-BANK-PROF-002 found');
  if (debit) {
    t.equal(debit.transactionType, 'bank_debit', 'debit row is bank_debit');
    t.equal(String(debit.grossAmount), '250', 'grossAmount is 250 (magnitude)');
    t.ok(
      String(debit.netAmount).startsWith('-250'),
      'netAmount is -250 (outflow)'
    );
  }

  t.end();
});

// ─── Idempotency: re-importing same file with same profile is a no-op ─────────

test('ImportProfile: re-importing same file with Profile A is idempotent (all skipped)', async (t) => {
  const orch = new DailyOrchestrator(fyo);
  const result = await orch.runProfileImport(profileAName, PROFILE_A_CONTENT);

  t.equal(result.imported, 0, 're-import: 0 new records');
  t.equal(result.skipped, 2, 're-import: 2 skipped (idempotent)');
  t.equal(result.errors.length, 0, 'no errors on idempotent re-import');
  t.end();
});

// ─── Error: unknown profile name ─────────────────────────────────────────────

test('ImportProfile: runProfileImport throws on unknown profile name', async (t) => {
  const orch = new DailyOrchestrator(fyo);
  let caught: Error | null = null;
  try {
    await orch.runProfileImport('PROFILE-DOES-NOT-EXIST', '[]');
  } catch (e) {
    caught = e instanceof Error ? e : new Error(String(e));
  }
  t.ok(caught, 'throws for unknown profile');
  t.ok(
    caught?.message.includes('not found'),
    `error says "not found" (got: ${caught?.message ?? ''})`
  );
  t.end();
});

// ─── Error: profile with missing required field ───────────────────────────────

test('ImportProfile: ProfileDrivenImporter rejects row missing required id field', async (t) => {
  // Create a throw-away profile for this test
  const doc = fyo.doc.getNewDoc(ModelNameEnum.DuhGoodsImportProfile);
  await doc.setMultiple({
    profileName: 'Strict PSP Profile',
    sourceType: 'psp_export',
    fileFormat: 'json',
    defaultSourceNamespace: 'psp:strict-test',
    columnMappings: JSON.stringify({}),
    parserOptions: JSON.stringify({}),
  });
  await doc.sync();
  const strictProfileName = doc.name as string;

  const badContent = JSON.stringify([
    {
      // no 'id' field
      date: '2026-05-01',
      type: 'payment',
      currency: 'SAR',
      gross: '100',
      fee: '0',
      tax: '0',
    },
  ]);

  const orch = new DailyOrchestrator(fyo);
  const result = await orch.runProfileImport(strictProfileName, badContent);

  // ImportOrchestrator catches ImportValidationError and records it as an error
  t.ok(
    result.errors.length > 0 || result.exceptions > 0,
    'row with missing id is recorded as an error or exception'
  );
  t.end();
});

closeTestFyo(fyo, __filename);
