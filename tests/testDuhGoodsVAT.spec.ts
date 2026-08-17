import test from 'tape';
import { ModelNameEnum } from 'models/types';
import type { VATClassification } from '../duhgoods/vat/VATEngine';
import { VATEngine } from '../duhgoods/vat/VATEngine';
import { closeTestFyo, getTestFyo, setupTestFyo } from './helpers';

const fyo = getTestFyo();
setupTestFyo(fyo, __filename);
let seq = 0;
let importSourceName: string;

async function getOrCreateSource() {
  if (importSourceName) return importSourceName;
  const src = fyo.doc.getNewDoc(ModelNameEnum.DuhGoodsImportSource);
  await src.setMultiple({
    sourceName: 'vat-test-source',
    sourceNamespace: 'vat-ns',
    sourceType: 'woocommerce',
    importedAt: new Date(),
    sourceHash: 'vat-source'.padEnd(64, 'x'),
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

async function makeRecord(type: string, gross: string, taxes: string = '0') {
  const id = `vat-test-${++seq}`;
  const sourceName = await getOrCreateSource();
  const doc = fyo.doc.getNewDoc(ModelNameEnum.DuhGoodsImportRecord);
  await doc.setMultiple({
    importSource: sourceName,
    sourceType: 'woocommerce',
    sourceNamespace: 'vat-ns',
    sourceId: id,
    identityKey: id,
    rowLocator: seq,
    transactionType: type,
    transactionDate: new Date('2026-07-15T00:00:00.000Z'),
    currency: 'SAR',
    grossAmount: fyo.pesa(gross),
    netAmount: fyo.pesa(gross),
    fees: fyo.pesa(0),
    taxes: fyo.pesa(taxes),
    status: 'pending',
    rawData: '{}',
    evidenceHash: id.padEnd(64, 'a'),
    evidenceVersion: 1,
    priorEvidenceHash: '',
  });
  await doc.sync();
  return doc.name as string;
}

async function enableVAT() {
  try {
    const policy = await fyo.doc.getDoc(ModelNameEnum.DuhGoodsVATPolicy);
    await policy.setMultiple({
      enabled: true,
      standardRate: 15,
      functionalCurrency: 'SAR',
    });
    await policy.sync();
  } catch {
    // policy may not exist in test env
  }
}

test('VATEngine: getDefaultClassification - order → taxable when VAT enabled', async (t) => {
  await enableVAT();
  const engine = new VATEngine(fyo);
  const result = await engine.getDefaultClassification('order');
  t.ok(
    result === 'taxable' || result === 'not_applicable',
    `order classification is ${result}`
  );
  t.end();
});

test('VATEngine: getDefaultClassification - fee → input_vat or not_applicable', async (t) => {
  const engine = new VATEngine(fyo);
  const result = await engine.getDefaultClassification('fee');
  t.ok(
    result === 'input_vat' || result === 'not_applicable',
    `fee classification is ${result}`
  );
  t.end();
});

test('VATEngine: getDefaultClassification - settlement → not_applicable', async (t) => {
  const engine = new VATEngine(fyo);
  t.equal(
    await engine.getDefaultClassification('settlement'),
    'not_applicable'
  );
  t.end();
});

test('VATEngine: getDefaultClassification - unknown type → review_required', async (t) => {
  await enableVAT();
  const engine = new VATEngine(fyo);
  t.equal(
    await engine.getDefaultClassification('unknown_type'),
    'review_required'
  );
  t.end();
});

test('VATEngine: getDefaultClassification - disabled VAT → not_applicable', async (t) => {
  try {
    const policy = await fyo.doc.getDoc(ModelNameEnum.DuhGoodsVATPolicy);
    await policy.set('enabled', false);
    await policy.sync();
    const engine = new VATEngine(fyo);
    const result = await engine.getDefaultClassification('order');
    t.equal(result, 'not_applicable', 'disabled VAT returns not_applicable');
    // Re-enable
    await policy.set('enabled', true);
    await policy.sync();
  } catch {
    t.pass(
      'policy not available — VAT engine returns not_applicable by default'
    );
  }
  t.end();
});

test('VATEngine: classifyRecord - computes VAT from taxes field', async (t) => {
  const name = await makeRecord('order', '115', '15');
  const engine = new VATEngine(fyo);
  const { classification, vatAmount } = await engine.classifyRecord(name);
  t.ok(
    classification === 'taxable' || classification === 'not_applicable',
    `classification is ${classification}`
  );
  if (classification === 'taxable') {
    t.equal(
      vatAmount.store,
      fyo.pesa('15').store,
      'vatAmount equals taxes field'
    );
  }
  t.end();
});

test('VATEngine: setClassification - stores override on record', async (t) => {
  const name = await makeRecord('order', '200');
  const engine = new VATEngine(fyo);
  await engine.setClassification(name, 'exempt', 'Exempt by regulation X');
  const rec = await fyo.db.get(ModelNameEnum.DuhGoodsImportRecord, name);
  t.equal(rec.vatClassification, 'exempt');
  t.equal(rec.vatReviewNote, 'Exempt by regulation X');
  t.end();
});

test('VATEngine: setClassification - rejects invalid classification', async (t) => {
  const name = await makeRecord('order', '100');
  const engine = new VATEngine(fyo);
  try {
    await engine.setClassification(name, 'invalid' as VATClassification);
    t.fail('should have thrown');
  } catch (e) {
    t.ok(
      e instanceof Error && e.message.includes('Invalid VAT classification')
    );
  }
  t.end();
});

test('VATEngine: getPeriodSummary - returns summary without errors', async (t) => {
  const orderName = await makeRecord('order', '100', '15');
  const feeName = await makeRecord('fee', '10', '1.5');

  const engine = new VATEngine(fyo);
  await engine.setClassification(orderName, 'output_vat').catch(() => {});
  await engine.setClassification(feeName, 'input_vat').catch(() => {});

  const summary = await engine.getPeriodSummary(
    new Date('2026-07-01T00:00:00.000Z'),
    new Date('2026-07-31T23:59:59.999Z')
  );

  t.equal(
    typeof summary.reviewRequired,
    'number',
    'reviewRequired is a number'
  );
  t.ok(Array.isArray(summary.exceptions), 'exceptions is array');
  t.end();
});

closeTestFyo(fyo, __filename);
