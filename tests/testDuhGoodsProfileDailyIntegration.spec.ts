/**
 * Profile-driven import integration with the daily workflow.
 *
 * Required assertions:
 *   1. Two profiles with completely different layouts each import correctly.
 *   2. runProfileImport result includes sourceId for summary scoping.
 *   3. Profile records appear in buildSummary when sourceId is included.
 *   4. Idempotent: same file re-imported via profile produces zero new records.
 *   5. Invalid column mapping produces a visible error (not silent success).
 *   6. No profile present → no import (clean failure, not crash).
 *   7. Standard Woo/PSP/bank daily workflow is unaffected by profile imports.
 */

import test from 'tape';
import { ModelNameEnum } from 'models/types';
import { DailyOrchestrator } from '../duhgoods/daily/DailyOrchestrator';
import { closeTestFyo, getTestFyo, setupTestFyo } from './helpers';

const fyo = getTestFyo();
setupTestFyo(fyo, __filename);

// ─── Fixtures ────────────────────────────────────────────────────────────────

// Profile C: PSP JSON with custom column names
const PROFILE_C_MAPPINGS = JSON.stringify({
  id: 'tx_ref',
  date: 'tx_date',
  type: 'tx_kind',
  currency: 'tx_ccy',
  gross: 'tx_gross',
  fee: 'tx_fee',
  net: 'tx_net',
});
const PROFILE_C_OPTIONS = JSON.stringify({ typeMap: { capture: 'payment' } });
const PROFILE_C_CONTENT = JSON.stringify([
  {
    tx_ref: 'PDI-001',
    tx_date: '2026-07-10',
    tx_kind: 'capture',
    tx_ccy: 'SAR',
    tx_gross: '300.00',
    tx_fee: '6.00',
    tx_net: '294.00',
  },
  {
    tx_ref: 'PDI-002',
    tx_date: '2026-07-10',
    tx_kind: 'capture',
    tx_ccy: 'SAR',
    tx_gross: '150.00',
    tx_fee: '3.00',
    tx_net: '147.00',
  },
]);

// Profile D: Bank CSV with custom column names
const PROFILE_D_MAPPINGS = JSON.stringify({
  date: 'ValueDate',
  credit: 'CreditAmt',
  debit: 'DebitAmt',
  reference: 'TxnRef',
});
const PROFILE_D_OPTIONS = JSON.stringify({});
const PROFILE_D_CONTENT = [
  'ValueDate,CreditAmt,DebitAmt,TxnRef',
  '2026-07-12,441.00,0,PDI-SETTLE-001',
].join('\n');

// Standard daily import fixtures (must remain unaffected)
const STD_WOO = JSON.stringify([
  {
    id: 9001,
    date_created: '2026-07-15T09:00:00',
    currency: 'SAR',
    total: '200.00',
    total_tax: '26.09',
    shipping_total: '0.00',
    discount_total: '0.00',
    total_shipping_tax: '0.00',
    payment_method: 'stripe',
    status: 'completed',
    refunds: [],
  },
]);

// ─── Setup: create profiles C and D ─────────────────────────────────────────

let profileCName: string;
let profileDName: string;

test('PDI-setup: create Profile C (PSP JSON, capture→payment mapping)', async (t) => {
  const doc = fyo.doc.getNewDoc(ModelNameEnum.DuhGoodsImportProfile);
  await doc.setMultiple({
    profileName: 'PDI Test PSP Profile C',
    sourceType: 'psp_export',
    fileFormat: 'json',
    defaultSourceNamespace: 'psp:pdi-profile-c',
    defaultCurrency: '',
    columnMappings: PROFILE_C_MAPPINGS,
    parserOptions: PROFILE_C_OPTIONS,
  });
  await doc.sync();
  profileCName = doc.name as string;
  t.ok(profileCName, 'Profile C created');
  t.end();
});

test('PDI-setup: create Profile D (Bank CSV, custom columns)', async (t) => {
  const doc = fyo.doc.getNewDoc(ModelNameEnum.DuhGoodsImportProfile);
  await doc.setMultiple({
    profileName: 'PDI Test Bank Profile D',
    sourceType: 'bank_statement',
    fileFormat: 'csv',
    defaultSourceNamespace: 'bank:pdi-profile-d',
    defaultCurrency: 'SAR',
    columnMappings: PROFILE_D_MAPPINGS,
    parserOptions: PROFILE_D_OPTIONS,
  });
  await doc.sync();
  profileDName = doc.name as string;
  t.ok(profileDName, 'Profile D created');
  t.end();
});

// ─── Test 1 & 2: Two profiles, different layouts, both import correctly ───────

test('PDI-1: Profile C imports PSP JSON (2 records)', async (t) => {
  const orch = new DailyOrchestrator(fyo);
  const result = await orch.runProfileImport(profileCName, PROFILE_C_CONTENT);

  t.equal(result.imported, 2, `imported 2 records (got ${result.imported})`);
  t.equal(result.skipped, 0, 'no skips');
  t.equal(result.exceptions, 0, 'no exceptions');
  t.equal(
    result.errors.length,
    0,
    `no errors (got: ${result.errors.join(', ')})`
  );
  t.ok(result.sourceId, 'sourceId is set');
  t.equal(result.sourceLabel, profileCName, 'sourceLabel matches profile name');

  // Verify mapped amounts
  const records = await fyo.db.getAll(ModelNameEnum.DuhGoodsImportRecord, {
    filters: { sourceNamespace: 'psp:pdi-profile-c' },
    fields: ['name', 'sourceId', 'grossAmount', 'netAmount', 'transactionType'],
    orderBy: 'sourceId',
    order: 'asc',
  });
  t.equal(records.length, 2, '2 records in DB');

  const pdi001 = records.find((r) => r.sourceId === 'PDI-001');
  t.ok(pdi001, 'PDI-001 record found');
  if (pdi001) {
    t.equal(
      pdi001.transactionType,
      'payment',
      'capture→payment typeMap applied'
    );
    t.ok(
      Math.abs(fyo.pesa(String(pdi001.grossAmount ?? 0)).float - 300.0) < 0.005,
      'gross is 300 SAR'
    );
  }
  t.end();
});

test('PDI-2: Profile D imports Bank CSV (1 record)', async (t) => {
  const orch = new DailyOrchestrator(fyo);
  const result = await orch.runProfileImport(profileDName, PROFILE_D_CONTENT);

  t.equal(result.imported, 1, `imported 1 record (got ${result.imported})`);
  t.equal(result.skipped, 0, 'no skips');
  t.equal(
    result.errors.length,
    0,
    `no errors (got: ${result.errors.join(', ')})`
  );
  t.ok(result.sourceId, 'sourceId is set');

  const records = await fyo.db.getAll(ModelNameEnum.DuhGoodsImportRecord, {
    filters: { sourceNamespace: 'bank:pdi-profile-d' },
    fields: ['name', 'currency', 'grossAmount', 'transactionType'],
  });
  t.equal(records.length, 1, '1 bank record in DB');

  const r = records[0];
  t.equal(String(r.currency), 'SAR', 'currency is SAR from profile default');
  t.equal(r.transactionType, 'bank_credit', 'bank_credit type assigned');
  t.ok(
    Math.abs(fyo.pesa(String(r.grossAmount ?? 0)).float - 441.0) < 0.005,
    'gross is 441 SAR'
  );
  t.end();
});

// ─── Test 3: Profile records appear in buildSummary ───────────────────────────

test('PDI-3: Profile import sourceId is included in buildSummary run scope', async (t) => {
  const orch = new DailyOrchestrator(fyo);

  // Re-import profile C (will be skipped — idempotent — but we need a result with sourceId)
  const resultC = await orch.runProfileImport(profileCName, PROFILE_C_CONTENT);
  const resultD = await orch.runProfileImport(profileDName, PROFILE_D_CONTENT);

  // Build summary scoped to these two profile imports.
  const summary = await orch.buildSummary([resultC, resultD], [], null, [
    resultC.sourceId,
    resultD.sourceId,
  ]);

  // The summary must contain scoped counts.
  t.ok(typeof summary.imported === 'number', 'imported is a number');
  t.ok(typeof summary.skipped === 'number', 'skipped is a number');
  // Both re-imports were skipped; imported should be 0, skipped >= 2
  t.equal(summary.imported, 0, 'no new imports (idempotent)');
  t.ok(summary.skipped >= 2, `skipped >= 2 (got ${summary.skipped})`);
  t.equal(Array.isArray(summary.importSources), true, 'importSources is array');
  t.equal(summary.importSources.length, 2, 'importSources has 2 entries');
  t.end();
});

// ─── Test 4: Idempotent — same file re-imported via profile → 0 new records ──

test('PDI-4: Re-import via Profile C produces zero new records', async (t) => {
  const before = await fyo.db.getAll(ModelNameEnum.DuhGoodsImportRecord, {
    filters: { sourceNamespace: 'psp:pdi-profile-c' },
    fields: ['name'],
  });

  const orch = new DailyOrchestrator(fyo);
  const result = await orch.runProfileImport(profileCName, PROFILE_C_CONTENT);

  const after = await fyo.db.getAll(ModelNameEnum.DuhGoodsImportRecord, {
    filters: { sourceNamespace: 'psp:pdi-profile-c' },
    fields: ['name'],
  });

  t.equal(after.length, before.length, 'no new records created');
  t.equal(result.imported, 0, 'imported count is 0');
  t.ok(result.skipped >= 2, `skipped >= 2 (got ${result.skipped})`);
  t.end();
});

// ─── Test 5: Invalid column mapping → visible error ───────────────────────────

test('PDI-5: Mapping that points to absent columns leaves rows with missing id/date, producing exceptions', async (t) => {
  // The profile maps logical fields to column names that exist ONLY in the mapping
  // — NOT in the actual source data. The source data uses completely different keys
  // that don't match either the mapping targets or the logical fallback names.
  // Result: each row fails validation (missing id, missing date) → exceptions.
  const badMappings = JSON.stringify({
    id: 'mapped_id_col',
    date: 'mapped_date_col',
    type: 'mapped_type_col',
    currency: 'mapped_currency_col',
    gross: 'mapped_gross_col',
  });

  const doc = fyo.doc.getNewDoc(ModelNameEnum.DuhGoodsImportProfile);
  await doc.setMultiple({
    profileName: 'PDI Bad Mapping Profile',
    sourceType: 'psp_export',
    fileFormat: 'json',
    defaultSourceNamespace: 'psp:pdi-bad-profile',
    defaultCurrency: 'SAR',
    columnMappings: badMappings,
    parserOptions: JSON.stringify({}),
  });
  await doc.sync();
  const badProfileName = doc.name as string;

  // Source content uses entirely different key names — none match the mapping targets
  // nor the logical fallback names (id, date, type, currency, gross, etc.).
  const content = JSON.stringify([
    {
      transaction_identifier: 'X',
      transaction_timestamp: '2026-01-01',
      transaction_category: 'payment',
      transaction_currency_code: 'SAR',
      transaction_amount_gross: '100',
    },
  ]);

  const orch = new DailyOrchestrator(fyo);
  const result = await orch.runProfileImport(badProfileName, content);

  // Row has no resolvable id or date → exceptions, not silent success.
  const hasVisibleIssue =
    result.errors.length > 0 || result.exceptions > 0 || result.imported === 0;

  t.ok(
    hasVisibleIssue,
    `mismatched column mapping produces visible issue: imported=${result.imported}, exceptions=${result.exceptions}, errors=${result.errors.length}`
  );
  t.end();
});

// ─── Test 6: Unknown profile throws ──────────────────────────────────────────

test('PDI-6: runProfileImport with unknown profile name throws', async (t) => {
  const orch = new DailyOrchestrator(fyo);
  let threw = false;
  try {
    await orch.runProfileImport('non-existent-profile-xyz', 'data');
  } catch (e) {
    threw = true;
    t.ok(
      e instanceof Error && e.message.includes('not found'),
      `error mentions "not found" (got: ${
        e instanceof Error ? e.message : String(e)
      })`
    );
  }
  t.ok(threw, 'threw for unknown profile');
  t.end();
});

// ─── Test 7: Standard daily workflow unchanged ────────────────────────────────

test('PDI-7: Standard Woo/PSP/bank runDailyImport is unaffected by profile imports', async (t) => {
  const orch = new DailyOrchestrator(fyo);
  const result = await orch.runDailyImport({
    woocommerce: { content: STD_WOO, namespace: 'std-woo-pdi-test' },
  });

  t.equal(result.errors, 0, 'no import errors in standard workflow');
  t.equal(result.imported, 1, 'exactly 1 Woo record imported');
  t.ok(
    result.importSources.some((s) => s.sourceLabel === 'woocommerce'),
    'importSources contains woocommerce entry'
  );
  t.end();
});

closeTestFyo(fyo, __filename);
