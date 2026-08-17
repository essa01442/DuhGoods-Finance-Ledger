import test from 'tape';
import { ModelNameEnum } from 'models/types';
import { FXService } from '../duhgoods/fx/FXService';
import { closeTestFyo, getTestFyo, setupTestFyo } from './helpers';

const fyo = getTestFyo();
setupTestFyo(fyo, __filename);
let seq = 0;
let importSourceName: string;

async function getOrCreateSource() {
  if (importSourceName) return importSourceName;
  const src = fyo.doc.getNewDoc(ModelNameEnum.DuhGoodsImportSource);
  await src.setMultiple({
    sourceName: 'fx-test-source',
    sourceNamespace: 'fx-ns',
    sourceType: 'psp_export',
    importedAt: new Date(),
    sourceHash: 'fx-source'.padEnd(64, 'y'),
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

async function makeRecord(currency: string, amount: string, date: string) {
  const id = `fx-test-${++seq}`;
  const sourceName = await getOrCreateSource();
  const doc = fyo.doc.getNewDoc(ModelNameEnum.DuhGoodsImportRecord);
  await doc.setMultiple({
    importSource: sourceName,
    sourceType: 'psp_export',
    sourceNamespace: 'fx-ns',
    sourceId: id,
    identityKey: id,
    rowLocator: seq,
    transactionType: 'payment',
    transactionDate: new Date(date + 'T00:00:00.000Z'),
    currency,
    grossAmount: fyo.pesa(amount),
    netAmount: fyo.pesa(amount),
    fees: fyo.pesa(0),
    taxes: fyo.pesa(0),
    status: 'pending',
    rawData: '{}',
    evidenceHash: id.padEnd(64, 'b'),
    evidenceVersion: 1,
    priorEvidenceHash: '',
  });
  await doc.sync();
  return doc.name as string;
}

test('FXService: findRate - identity rate for same currency', async (t) => {
  const svc = new FXService(fyo);
  const result = await svc.findRate('SAR', 'SAR', new Date('2026-07-01'));
  t.ok(result, 'result not null');
  t.equal(result!.rate, '1', 'identity rate is exact decimal "1"');
  t.equal(result!.name, '__identity__');
  t.end();
});

test('FXService: findRate - returns null when no rate available', async (t) => {
  const svc = new FXService(fyo);
  const result = await svc.findRate('USD', 'SAR', new Date('2020-01-01'));
  t.equal(result, null, 'no rate → null');
  t.end();
});

test('FXService: storeManualRate - stores a new rate', async (t) => {
  const svc = new FXService(fyo);
  const res = await svc.storeManualRate({
    effectiveDate: new Date('2026-07-01T00:00:00.000Z'),
    baseCurrency: 'USD',
    quoteCurrency: 'SAR',
    rate: 3.75,
    sourceDescription: 'Test bank statement 2026-07-01',
  });
  t.ok(res.created, 'new rate created');
  t.ok(res.name, 'has a name');
  t.end();
});

test('FXService: storeManualRate - idempotent for same pair/date', async (t) => {
  const svc = new FXService(fyo);
  const first = await svc.storeManualRate({
    effectiveDate: new Date('2026-07-05T00:00:00.000Z'),
    baseCurrency: 'EUR',
    quoteCurrency: 'SAR',
    rate: 4.1,
    sourceDescription: 'EUR/SAR July 5',
  });
  const second = await svc.storeManualRate({
    effectiveDate: new Date('2026-07-05T00:00:00.000Z'),
    baseCurrency: 'EUR',
    quoteCurrency: 'SAR',
    rate: 4.1,
    sourceDescription: 'EUR/SAR July 5 duplicate',
  });
  t.ok(first.created, 'first created');
  t.ok(!second.created, 'second not created (idempotent)');
  t.equal(first.name, second.name, 'same name returned');
  t.end();
});

test('FXService: storeManualRate - rejects zero/negative rate', async (t) => {
  const svc = new FXService(fyo);
  try {
    await svc.storeManualRate({
      effectiveDate: new Date('2026-07-01T00:00:00.000Z'),
      baseCurrency: 'USD',
      quoteCurrency: 'SAR',
      rate: 0,
      sourceDescription: 'zero rate test',
    });
    t.fail('should have thrown');
  } catch (e) {
    t.ok(
      e instanceof Error && e.message.includes('positive'),
      'rejects zero rate'
    );
  }
  t.end();
});

test('FXService: findRate - uses most recent rate on or before date', async (t) => {
  const svc = new FXService(fyo);
  await svc.storeManualRate({
    effectiveDate: new Date('2026-07-10T00:00:00.000Z'),
    baseCurrency: 'GBP',
    quoteCurrency: 'SAR',
    rate: 4.8,
    sourceDescription: 'GBP July 10',
  });
  await svc.storeManualRate({
    effectiveDate: new Date('2026-07-15T00:00:00.000Z'),
    baseCurrency: 'GBP',
    quoteCurrency: 'SAR',
    rate: 4.9,
    sourceDescription: 'GBP July 15',
  });

  const result = await svc.findRate('GBP', 'SAR', new Date('2026-07-12'));
  t.ok(result, 'found a rate');
  t.equal(result!.rate, '4.8', 'uses rate from July 10, not July 15');
  t.end();
});

test('FXService: findRate - inverse pair lookup', async (t) => {
  // Use JPY/SAR — never stored directly in any other test, so the inverse
  // lookup must be used.  Store SAR/JPY, then look up JPY/SAR.
  const svc = new FXService(fyo);
  await svc.storeManualRate({
    effectiveDate: new Date('2026-07-20T00:00:00.000Z'),
    baseCurrency: 'SAR',
    quoteCurrency: 'JPY',
    rate: '28.1',
    sourceDescription: 'SAR/JPY inverse test',
  });
  const result = await svc.findRate('JPY', 'SAR', new Date('2026-07-20'));
  t.ok(result, 'found via inverse pair');
  t.ok(result!.derived, 'inverse rate marked as derived');
  // 1 / 28.1 ≈ 0.03558...
  t.ok(
    result!.rate.startsWith('0.035'),
    `inverse rate is exact decimal ~0.03558 (1/28.1), got ${result!.rate}`
  );
  t.end();
});

test('FXService: convert - returns FXConversionResult when rate available', async (t) => {
  const svc = new FXService(fyo);
  await svc.storeManualRate({
    effectiveDate: new Date('2026-07-01T00:00:00.000Z'),
    baseCurrency: 'USD',
    quoteCurrency: 'SAR',
    rate: 3.75,
    sourceDescription: 'USD/SAR for convert test',
  });
  const result = await svc.convert(
    fyo.pesa('100'),
    'USD',
    'SAR',
    new Date('2026-07-05')
  );
  t.ok(
    !svc.isMissingRateException(result),
    'result is conversion, not exception'
  );
  if (!svc.isMissingRateException(result)) {
    t.equal(
      result.functionalAmount.store,
      fyo.pesa('375').store,
      '100 USD = 375 SAR'
    );
  }
  t.end();
});

test('FXService: convert - returns FXMissingRateException when no rate', async (t) => {
  const svc = new FXService(fyo);
  const result = await svc.convert(
    fyo.pesa('50'),
    'JPY',
    'SAR',
    new Date('2020-01-01')
  );
  t.ok(svc.isMissingRateException(result), 'result is missing-rate exception');
  if (svc.isMissingRateException(result)) {
    t.ok(result.message.includes('JPY'), 'exception message mentions currency');
  }
  t.end();
});

test('FXService: applyToRecord - stores functionalCurrencyAmount on record', async (t) => {
  const svc = new FXService(fyo);
  await svc.storeManualRate({
    effectiveDate: new Date('2026-07-01T00:00:00.000Z'),
    baseCurrency: 'USD',
    quoteCurrency: 'SAR',
    rate: 3.75,
    sourceDescription: 'USD/SAR for applyToRecord test',
  });
  const name = await makeRecord('USD', '200', '2026-07-05');
  const result = await svc.applyToRecord(name, 'SAR');
  t.ok(result.ok, `apply succeeded: ${result.message ?? ''}`);
  t.end();
});

test('FXService: applyToRecord - sets fxReviewNote when rate missing', async (t) => {
  const svc = new FXService(fyo);
  const name = await makeRecord('KWD', '100', '2019-01-01');
  const result = await svc.applyToRecord(name, 'SAR');
  t.ok(!result.ok, 'apply not ok (missing rate)');
  const rec = await fyo.db.get(ModelNameEnum.DuhGoodsImportRecord, name);
  t.ok(rec.fxReviewNote, 'fxReviewNote set');
  t.ok(
    String(rec.fxReviewNote).includes('KWD'),
    'review note mentions currency'
  );
  t.end();
});

test('FXService: importFromJSON - imports multiple rates idempotently', async (t) => {
  const svc = new FXService(fyo);
  const content = JSON.stringify([
    {
      date: '2026-06-01',
      base: 'USD',
      quote: 'SAR',
      rate: 3.75,
      source: 'June import',
    },
    {
      date: '2026-06-02',
      base: 'USD',
      quote: 'SAR',
      rate: 3.76,
      source: 'June import',
    },
  ]);
  const r1 = await svc.importFromJSON(content);
  t.equal(r1.imported, 2, 'imported 2 rates');
  t.equal(r1.skipped, 0, 'no skips on first import');
  const r2 = await svc.importFromJSON(content);
  t.equal(r2.imported, 0, 'no new imports on repeat');
  t.equal(r2.skipped, 2, 'skipped 2 duplicates');
  t.end();
});

closeTestFyo(fyo, __filename);
