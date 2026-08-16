import test from 'tape';
import { BankStatementImporter } from '../duhgoods/importers/BankStatementImporter';
import { PSPExportImporter } from '../duhgoods/importers/PSPExportImporter';
import { WooCommerceImporter } from '../duhgoods/importers/WooCommerceImporter';
import {
  computeEvidenceHash,
  computeFileHash,
} from '../duhgoods/evidence/EvidenceManager';

// ── EvidenceManager ──────────────────────────────────────────────────────────

test('computeEvidenceHash: produces stable hex string', (t) => {
  const hash = computeEvidenceHash({ id: 1, amount: 100 });
  t.equal(typeof hash, 'string', 'returns string');
  t.equal(hash.length, 64, 'SHA-256 hex is 64 chars');
  t.end();
});

test('computeEvidenceHash: key-order independent', (t) => {
  const a = computeEvidenceHash({ id: 1, amount: 100 });
  const b = computeEvidenceHash({ amount: 100, id: 1 });
  t.equal(a, b, 'same hash regardless of key order');
  t.end();
});

test('computeEvidenceHash: different data yields different hash', (t) => {
  const a = computeEvidenceHash({ id: 1 });
  const b = computeEvidenceHash({ id: 2 });
  t.notEqual(a, b, 'different data → different hash');
  t.end();
});

test('computeFileHash: produces stable hex string', (t) => {
  const hash = computeFileHash('hello world');
  t.equal(typeof hash, 'string', 'returns string');
  t.equal(hash.length, 64, 'SHA-256 hex is 64 chars');
  t.end();
});

test('computeFileHash: deterministic', (t) => {
  const a = computeFileHash('test content');
  const b = computeFileHash('test content');
  t.equal(a, b, 'same input → same hash');
  t.end();
});

// ── WooCommerceImporter ──────────────────────────────────────────────────────

const wooOrders = [
  {
    id: 101,
    status: 'completed',
    date_paid: '2024-01-15T10:00:00',
    currency: 'SAR',
    total: '500.00',
    total_tax: '65.00',
    shipping_total: '20.00',
    discount_total: '10.00',
  },
  {
    id: 102,
    status: 'refunded',
    date_paid: '2024-01-16T12:00:00',
    currency: 'SAR',
    total: '200.00',
    total_tax: '26.00',
    shipping_total: '0.00',
    discount_total: '0.00',
  },
];

test('WooCommerceImporter: parses order array', async (t) => {
  const importer = new WooCommerceImporter();
  const txns = await importer.parse(JSON.stringify(wooOrders));

  t.equal(txns.length, 2, 'two transactions');
  t.equal(txns[0].sourceId, '101', 'sourceId from order id');
  t.equal(txns[0].sourceType, 'woocommerce', 'correct source type');
  t.equal(txns[0].transactionType, 'order', 'completed → order');
  t.equal(txns[1].transactionType, 'refund', 'refunded → refund');
  t.equal(txns[0].currency, 'SAR', 'currency preserved');
  t.equal(txns[0].grossAmount, 500, 'gross amount');
  t.equal(txns[0].taxes, 65, 'tax amount');
  t.end();
});

test('WooCommerceImporter: rawData preserved', async (t) => {
  const importer = new WooCommerceImporter();
  const txns = await importer.parse(JSON.stringify(wooOrders));
  t.equal(txns[0].rawData.id, 101, 'raw order id in rawData');
  t.end();
});

test('WooCommerceImporter: rejects non-array input', async (t) => {
  const importer = new WooCommerceImporter();
  try {
    await importer.parse(JSON.stringify({ id: 1 }));
    t.fail('should have thrown');
  } catch (err) {
    t.ok(err instanceof Error, 'throws Error for non-array');
  }
  t.end();
});

// ── BankStatementImporter ────────────────────────────────────────────────────

const bankRows = [
  {
    date: '2024-01-10',
    description: 'Customer payment',
    credit: '1500.00',
    debit: '',
    reference: 'REF001',
  },
  {
    date: '2024-01-11',
    description: 'Supplier payment',
    credit: '',
    debit: '800.00',
    reference: 'REF002',
  },
];

test('BankStatementImporter: parses rows', async (t) => {
  const importer = new BankStatementImporter('SAR');
  const txns = await importer.parse(JSON.stringify(bankRows));

  t.equal(txns.length, 2, 'two rows');
  t.equal(txns[0].transactionType, 'bank_credit', 'credit row');
  t.equal(txns[1].transactionType, 'bank_debit', 'debit row');
  t.equal(txns[0].grossAmount, 1500, 'credit amount');
  t.equal(txns[1].grossAmount, 800, 'debit amount');
  t.equal(txns[0].sourceId, 'REF001', 'reference used as sourceId');
  t.end();
});

test('BankStatementImporter: uses default SAR currency', async (t) => {
  const importer = new BankStatementImporter();
  const txns = await importer.parse(JSON.stringify(bankRows));
  t.equal(txns[0].currency, 'SAR', 'defaults to SAR');
  t.end();
});

test('BankStatementImporter: rejects non-array', async (t) => {
  const importer = new BankStatementImporter();
  try {
    await importer.parse('{}');
    t.fail('should throw');
  } catch (err) {
    t.ok(err instanceof Error, 'throws Error');
  }
  t.end();
});

// ── PSPExportImporter ────────────────────────────────────────────────────────

const pspRows = [
  {
    id: 'TXN-001',
    type: 'payment',
    date: '2024-01-20',
    currency: 'SAR',
    gross: '300.00',
    fee: '9.00',
    tax: '1.35',
    net: '289.65',
  },
  {
    id: 'TXN-002',
    type: 'refund',
    date: '2024-01-21',
    currency: 'SAR',
    gross: '-150.00',
    fee: '0.00',
    tax: '0.00',
    net: '-150.00',
  },
  {
    id: 'TXN-003',
    type: 'chargeback',
    date: '2024-01-22',
    currency: 'SAR',
    gross: '-200.00',
    fee: '15.00',
    tax: '0.00',
    net: '-215.00',
  },
];

test('PSPExportImporter: parses rows', async (t) => {
  const importer = new PSPExportImporter();
  const txns = await importer.parse(JSON.stringify(pspRows));

  t.equal(txns.length, 3, 'three rows');
  t.equal(txns[0].transactionType, 'payment', 'payment type');
  t.equal(txns[1].transactionType, 'refund', 'refund type');
  t.equal(txns[2].transactionType, 'chargeback', 'chargeback type');
  t.equal(txns[0].sourceId, 'TXN-001', 'sourceId from id field');
  t.equal(txns[0].fees, 9, 'fee captured');
  t.equal(txns[0].netAmount, 289.65, 'net amount');
  t.end();
});

test('PSPExportImporter: uppercases currency', async (t) => {
  const importer = new PSPExportImporter();
  const rows = [
    {
      id: 'X1',
      type: 'payment',
      date: '2024-01-01',
      currency: 'sar',
      gross: '100',
      fee: '0',
      tax: '0',
      net: '100',
    },
  ];
  const txns = await importer.parse(JSON.stringify(rows));
  t.equal(txns[0].currency, 'SAR', 'currency uppercased');
  t.end();
});

test('PSPExportImporter: falls back to payment for unknown type', async (t) => {
  const importer = new PSPExportImporter();
  const rows = [
    {
      id: 'X1',
      type: 'unknown_type',
      date: '2024-01-01',
      currency: 'SAR',
      gross: '100',
      fee: '0',
      tax: '0',
      net: '100',
    },
  ];
  const txns = await importer.parse(JSON.stringify(rows));
  t.equal(
    txns[0].transactionType,
    'payment',
    'unknown type falls back to payment'
  );
  t.end();
});

// ── Idempotency: same raw data yields same hash ──────────────────────────────

test('evidenceHash idempotency across importers', async (t) => {
  const wooImporter = new WooCommerceImporter();
  const txns1 = await wooImporter.parse(JSON.stringify(wooOrders));
  const txns2 = await wooImporter.parse(JSON.stringify(wooOrders));

  const hash1 = computeEvidenceHash(txns1[0].rawData);
  const hash2 = computeEvidenceHash(txns2[0].rawData);
  t.equal(hash1, hash2, 'same source data → identical evidence hash');
  t.end();
});
