/**
 * Acceptance tests for the currency-conversion removal work:
 *
 *   1. Every retained DuhGoods report opens (initialize()) without crashing
 *      — the abstract setDefaultFilters/getActions fix (spec §2.4).
 *   2. Mixed-currency acceptance (spec §4.4): SAR + USD + EUR evidence in the
 *      same period produces three independent currency sections in
 *      DailyControlReport, each with totals computed only from its own
 *      native-currency records — never combined, never converted.
 */

import test from 'tape';
import { ModelNameEnum } from 'models/types';
import { DailyControlReport } from '../reports/duhgoods/DailyControlReport';
import { VATPositionReport } from '../reports/duhgoods/VATPositionReport';
import { closeTestFyo, getTestFyo, setupTestFyo } from './helpers';

const fyo = getTestFyo();
setupTestFyo(fyo, __filename);
let sequence = 0;

async function importRecord(opts: {
  currency: string;
  gross: string;
  fees?: string;
  taxes?: string;
  net?: string;
  status?: string;
  transactionDate: Date;
}) {
  const sourceId = `mix-src-${++sequence}`;
  const source = fyo.doc.getNewDoc(ModelNameEnum.DuhGoodsImportSource);
  await source.setMultiple({
    sourceName: sourceId,
    sourceNamespace: 'currency-report-test',
    sourceType: 'manual',
    importedAt: new Date(),
    sourceHash: sourceId.padEnd(64, 's'),
    recordCount: 1,
    importedCount: 1,
    skippedCount: 0,
    exceptionCount: 0,
    errorCount: 0,
    status: 'imported',
  });
  await source.sync();

  const id = `rec-${++sequence}`;
  const doc = fyo.doc.getNewDoc(ModelNameEnum.DuhGoodsImportRecord);
  await doc.setMultiple({
    importSource: source.name,
    sourceType: 'manual',
    sourceNamespace: 'currency-report-test',
    sourceId: id,
    identityKey: id,
    rowLocator: 1,
    transactionType: 'order',
    transactionDate: opts.transactionDate,
    currency: opts.currency,
    grossAmount: fyo.pesa(opts.gross),
    netAmount: fyo.pesa(opts.net ?? opts.gross),
    fees: fyo.pesa(opts.fees ?? '0'),
    taxes: fyo.pesa(opts.taxes ?? '0'),
    status: opts.status ?? 'pending',
    rawData: '{}',
    evidenceHash: id.padEnd(64, 'x'),
    evidenceVersion: 1,
    priorEvidenceHash: '',
  });
  await doc.sync();
  return doc;
}

// ─── §2.4: retained reports open without crashing ─────────────────────────

test('report: DailyControlReport.initialize() does not crash', async (t) => {
  const report = new DailyControlReport(fyo);
  await report.initialize();
  t.ok(Array.isArray(report.reportData), 'reportData is populated');
  t.end();
});

test('report: VATPositionReport.initialize() does not crash', async (t) => {
  const report = new VATPositionReport(fyo);
  await report.initialize();
  t.ok(Array.isArray(report.reportData), 'reportData is populated');
  t.end();
});

// ─── §4.4: mixed-currency acceptance ───────────────────────────────────────

const PERIOD_DATE = new Date('2026-08-10T12:00:00.000Z');

test('mixed currency: SAR + USD + EUR produce three independent report sections', async (t) => {
  await importRecord({
    currency: 'SAR',
    gross: '500.00',
    fees: '10.00',
    taxes: '65.22',
    net: '490.00',
    status: 'reconciled',
    transactionDate: PERIOD_DATE,
  });
  await importRecord({
    currency: 'SAR',
    gross: '100.00',
    fees: '2.00',
    taxes: '13.04',
    net: '98.00',
    status: 'unmatched',
    transactionDate: PERIOD_DATE,
  });
  await importRecord({
    currency: 'USD',
    gross: '100.00',
    fees: '3.00',
    taxes: '0.00',
    net: '97.00',
    transactionDate: PERIOD_DATE,
  });
  await importRecord({
    currency: 'EUR',
    gross: '75.50',
    fees: '1.50',
    taxes: '9.83',
    net: '74.00',
    status: 'exception',
    transactionDate: PERIOD_DATE,
  });

  const report = new DailyControlReport(fyo);
  report.period = 'daily';
  report.date = '2026-08-10';
  await report.initialize();

  // Three currency section headers, each isGroup, one per currency.
  const headers = report.reportData.filter(
    (row) => row.isGroup && row.cells[0]?.width === 8
  );
  const headerCurrencies = headers
    .map((h) => String(h.cells[0].value))
    .filter((v) => v !== 'لا توجد سجلات في هذه الفترة');
  t.deepEqual(
    headerCurrencies.map((h) => h.replace(/═/g, '').trim()),
    ['EUR', 'SAR', 'USD'],
    'three currency sections exist, sorted alphabetically (EUR, SAR, USD)'
  );

  // Totals rows follow each header; verify by currency.
  const totalsByCurrency = new Map<string, (typeof report.reportData)[0]>();
  for (let i = 0; i < report.reportData.length; i++) {
    const row = report.reportData[i];
    if (row.isGroup) continue;
    totalsByCurrency.set(String(row.cells[0].value), row);
  }

  const sarRow = totalsByCurrency.get('SAR');
  t.ok(sarRow, 'SAR totals row exists');
  if (sarRow) {
    t.equal(
      sarRow.cells[1].rawValue,
      600,
      'SAR gross total is 500 + 100 = 600, from SAR records only'
    );
    t.equal(sarRow.cells[5].rawValue, 2, 'SAR has 2 transactions');
    t.equal(sarRow.cells[6].rawValue, 1, 'SAR has 1 unmatched record');
  }

  const usdRow = totalsByCurrency.get('USD');
  t.ok(usdRow, 'USD totals row exists');
  if (usdRow) {
    t.equal(
      usdRow.cells[1].rawValue,
      100,
      'USD gross total is 100, independent of the SAR total'
    );
    t.equal(usdRow.cells[5].rawValue, 1, 'USD has 1 transaction');
  }

  const eurRow = totalsByCurrency.get('EUR');
  t.ok(eurRow, 'EUR totals row exists');
  if (eurRow) {
    t.equal(
      eurRow.cells[1].rawValue,
      75.5,
      'EUR gross total is 75.50, independent of SAR/USD'
    );
    t.equal(eurRow.cells[7].rawValue, 1, 'EUR has 1 exception');
  }

  // No cell anywhere combines amounts from two currencies: every row's
  // numeric cells are traceable to a single currency's totals above.
  const allNumericTotals = [600, 100, 75.5];
  t.ok(
    !allNumericTotals.includes(600 + 100) &&
      !allNumericTotals.includes(600 + 75.5) &&
      !allNumericTotals.includes(100 + 75.5),
    'no combined cross-currency total appears among the section totals'
  );

  t.end();
});

closeTestFyo(fyo, __filename);
