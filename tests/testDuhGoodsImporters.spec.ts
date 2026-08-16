import fs from 'fs';
import os from 'os';
import path from 'path';
import test from 'tape';
import { BankStatementImporter } from '../duhgoods/importers/BankStatementImporter';
import { PSPExportImporter } from '../duhgoods/importers/PSPExportImporter';
import { WooCommerceImporter } from '../duhgoods/importers/WooCommerceImporter';
import {
  ImportValidationError,
  ImportedTransaction,
} from '../duhgoods/importers/types';
import {
  ImportOrchestrator,
  InsertRecordMeta,
} from '../duhgoods/importers/ImportOrchestrator';
import {
  computeEvidenceHash,
  computeFileHash,
  computeIdentityKey,
} from '../duhgoods/evidence/EvidenceManager';
import {
  getTestFyo,
  getTestDbPath,
  getTestSetupWizardOptions,
} from './helpers';
import setupInstance from 'src/setup/setupInstance';
import { DatabaseManager } from 'backend/database/manager';

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

test('computeEvidenceHash: sourceType namespace in identity prevents cross-source collision', (t) => {
  const rawData = { id: 'TXN-001', amount: 100 };
  const wooHash = computeEvidenceHash({
    sourceType: 'woocommerce',
    sourceId: 'TXN-001',
    raw: rawData,
  });
  const pspHash = computeEvidenceHash({
    sourceType: 'psp_export',
    sourceId: 'TXN-001',
    raw: rawData,
  });
  t.notEqual(
    wooHash,
    pspHash,
    'same raw JSON from different source types → different hashes'
  );
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

test('computeFileHash vs computeEvidenceHash: same multi-record source distinguishes batch from per-record', (t) => {
  const sourceContent = JSON.stringify(wooOrdersValid);
  const fileHash = computeFileHash(sourceContent);
  const wooImporter = new WooCommerceImporter();
  const txns = wooImporter.parse(sourceContent);
  const recordHash = computeEvidenceHash({
    sourceType: txns[0].sourceType,
    sourceId: txns[0].sourceId,
    raw: txns[0].rawData,
  });
  t.equal(fileHash.length, 64, 'file hash is SHA-256 hex');
  t.equal(recordHash.length, 64, 'evidence hash is SHA-256 hex');
  t.notEqual(
    fileHash,
    recordHash,
    'file (multi-record batch) hash ≠ single-record evidence hash'
  );
  t.end();
});

// ── WooCommerceImporter — valid cases ────────────────────────────────────────

const wooOrdersValid = [
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
    // No refunds[] — triggers synthetic full-refund path.
  },
];

test('WooCommerceImporter: parses completed order and synthesises refund for refunded order', (t) => {
  const importer = new WooCommerceImporter();
  const txns = importer.parse(JSON.stringify(wooOrdersValid));

  t.equal(txns.length, 2, 'two transactions');
  t.equal(txns[0].sourceId, '101', 'sourceId from order id');
  t.equal(txns[0].sourceType, 'woocommerce', 'correct source type');
  t.equal(txns[0].transactionType, 'order', 'completed → order');
  t.equal(txns[1].transactionType, 'refund', 'refunded → refund');
  t.equal(txns[0].currency, 'SAR', 'currency preserved');
  // Amounts are decimal strings, not JS Numbers.
  t.equal(txns[0].grossAmount, '500.00', 'gross is source string');
  t.equal(txns[0].taxes, '65.00', 'tax is source string');
  t.equal(txns[0].fees, '0', 'fees = "0" (PSP fees absent in WooCommerce)');
  t.equal(txns[0].netAmount, '435.000000', 'net = gross − taxes via pesa');
  t.end();
});

test('WooCommerceImporter: processing status maps to order', (t) => {
  const importer = new WooCommerceImporter();
  const orders = [
    {
      id: 200,
      status: 'processing',
      date_paid: '2024-01-01T00:00:00',
      currency: 'SAR',
      total: '100',
      total_tax: '15',
      shipping_total: '0',
      discount_total: '0',
    },
  ];
  const txns = importer.parse(JSON.stringify(orders));
  t.equal(txns.length, 1, 'processing produces one transaction');
  t.equal(txns[0].transactionType, 'order', 'processing → order');
  t.end();
});

test('WooCommerceImporter: skipped statuses produce no transactions', (t) => {
  const importer = new WooCommerceImporter();
  const orders = [
    {
      id: 1,
      status: 'pending',
      date_created: '2024-01-01',
      currency: 'SAR',
      total: '0',
      total_tax: '0',
      shipping_total: '0',
      discount_total: '0',
    },
    {
      id: 2,
      status: 'cancelled',
      date_created: '2024-01-01',
      currency: 'SAR',
      total: '0',
      total_tax: '0',
      shipping_total: '0',
      discount_total: '0',
    },
    {
      id: 3,
      status: 'failed',
      date_created: '2024-01-01',
      currency: 'SAR',
      total: '0',
      total_tax: '0',
      shipping_total: '0',
      discount_total: '0',
    },
    {
      id: 4,
      status: 'on-hold',
      date_created: '2024-01-01',
      currency: 'SAR',
      total: '0',
      total_tax: '0',
      shipping_total: '0',
      discount_total: '0',
    },
  ];
  const txns = importer.parse(JSON.stringify(orders));
  t.equal(
    txns.length,
    0,
    'pending/cancelled/failed/on-hold produce zero transactions'
  );
  t.end();
});

test('WooCommerceImporter: rawData is exact source bytes; shipping and discount go in normalizedMeta', (t) => {
  const importer = new WooCommerceImporter();
  const txns = importer.parse(JSON.stringify(wooOrdersValid));
  // rawData must NOT be augmented — these keys must be absent.
  t.equal(
    txns[0].rawData['_woo_shipping_total'],
    undefined,
    '_woo_shipping_total absent from rawData'
  );
  t.equal(
    txns[0].rawData['_woo_discount_total'],
    undefined,
    '_woo_discount_total absent from rawData'
  );
  // Derived values go into normalizedMeta, not rawData.
  t.equal(
    txns[0].normalizedMeta?.shippingTotal,
    '20.00',
    'shippingTotal in normalizedMeta'
  );
  t.equal(
    txns[0].normalizedMeta?.discountTotal,
    '10.00',
    'discountTotal in normalizedMeta'
  );
  t.equal(
    txns[0].fees,
    '0',
    'fees not populated from WooCommerce shipping/discount'
  );
  t.end();
});

test('WooCommerceImporter: refunds[] array produces individual refund records', (t) => {
  const importer = new WooCommerceImporter();
  const orders = [
    {
      id: 500,
      status: 'completed',
      date_paid: '2024-01-15T10:00:00',
      currency: 'SAR',
      total: '500.00',
      total_tax: '65.00',
      shipping_total: '0.00',
      discount_total: '0.00',
      refunds: [
        {
          id: 9001,
          date_created: '2024-01-20T10:00:00',
          amount: '100.00',
          reason: 'partial return',
        },
      ],
    },
  ];
  const txns = importer.parse(JSON.stringify(orders));
  // Completed order + one partial refund from refunds[].
  t.equal(txns.length, 2, 'order + one refund record');
  t.equal(txns[0].transactionType, 'order', 'first is order');
  t.equal(txns[0].sourceId, '500', 'order sourceId');
  t.equal(txns[1].transactionType, 'refund', 'second is refund');
  t.equal(txns[1].sourceId, '9001', 'refund sourceId from refund.id');
  // WooCommerce refund amounts are positive in source; adapter negates.
  t.equal(txns[1].grossAmount, '-100.000000', 'refund gross is negated');
  t.equal(txns[1].netAmount, '-100.000000', 'refund net is negated');
  t.equal(txns[1].fees, '0', 'refund fees = "0"');
  t.equal(txns[1].taxes, '0', 'refund taxes = "0"');
  t.equal(
    txns[1].normalizedMeta?.parentOrderId,
    '500',
    'parentOrderId in normalizedMeta'
  );
  // rawData for the refund is the refund object, not the parent order.
  t.equal(
    (txns[1].rawData as { id: number }).id,
    9001,
    'refund rawData is refund object'
  );
  t.end();
});

test('WooCommerceImporter: refunded status with refunds[] imports individual refunds (not order)', (t) => {
  const importer = new WooCommerceImporter();
  const orders = [
    {
      id: 600,
      status: 'refunded',
      date_paid: '2024-01-15T10:00:00',
      currency: 'SAR',
      total: '300.00',
      total_tax: '39.00',
      shipping_total: '0.00',
      discount_total: '0.00',
      refunds: [
        { id: 9002, date_created: '2024-01-16T10:00:00', amount: '300.00' },
      ],
    },
  ];
  const txns = importer.parse(JSON.stringify(orders));
  // refunded status + refunds[] → only the refund records, not the order.
  t.equal(txns.length, 1, 'only refund records, not the order');
  t.equal(txns[0].sourceId, '9002', 'refund sourceId');
  t.equal(txns[0].transactionType, 'refund', 'transaction type is refund');
  t.equal(txns[0].grossAmount, '-300.000000', 'refund gross negated');
  t.end();
});

test('WooCommerceImporter: synthetic full refund sign convention (refunded, no refunds[])', (t) => {
  const importer = new WooCommerceImporter();
  // wooOrdersValid[1] is status='refunded' with no refunds[] array.
  const txns = importer.parse(JSON.stringify(wooOrdersValid));
  const refund = txns[1];
  t.equal(refund.transactionType, 'refund', 'refund type');
  t.equal(refund.grossAmount, '-200.000000', 'gross is negated order total');
  t.equal(refund.taxes, '-26.000000', 'taxes is negated order tax');
  t.equal(refund.fees, '0', 'fees = "0"');
  // netAmount = gross − taxes = -200 − (-26) = -174
  t.equal(refund.netAmount, '-174.000000', 'net = gross − taxes');
  t.ok(
    refund.normalizedMeta?.syntheticFullRefund,
    'syntheticFullRefund flag in normalizedMeta'
  );
  t.end();
});

test('WooCommerceImporter: rejects non-array input', (t) => {
  const importer = new WooCommerceImporter();
  t.throws(
    () => importer.parse(JSON.stringify({ id: 1 })),
    /must be a JSON array/,
    'throws for non-array'
  );
  t.end();
});

// ── WooCommerceImporter — rejection cases ───────────────────────────────────

test('WooCommerceImporter: missing currency throws ImportValidationError', (t) => {
  const importer = new WooCommerceImporter();
  const orders = [
    {
      id: 700,
      status: 'completed',
      date_paid: '2024-01-01T00:00:00',
      // currency omitted — must not default to SAR
      total: '100.00',
      total_tax: '0.00',
      shipping_total: '0.00',
      discount_total: '0.00',
    },
  ];
  t.throws(
    () => importer.parse(JSON.stringify(orders)),
    (err: unknown) =>
      err instanceof ImportValidationError &&
      /currency.*missing/i.test(err.message),
    'throws ImportValidationError when currency is absent'
  );
  t.end();
});

test('WooCommerceImporter: blank currency throws ImportValidationError', (t) => {
  const importer = new WooCommerceImporter();
  const orders = [
    {
      id: 701,
      status: 'completed',
      date_paid: '2024-01-01T00:00:00',
      currency: '   ',
      total: '100.00',
      total_tax: '0.00',
      shipping_total: '0.00',
      discount_total: '0.00',
    },
  ];
  t.throws(
    () => importer.parse(JSON.stringify(orders)),
    (err: unknown) =>
      err instanceof ImportValidationError &&
      /currency.*missing/i.test(err.message),
    'throws ImportValidationError for blank currency'
  );
  t.end();
});

test('WooCommerceImporter: unsupported status throws ImportValidationError', (t) => {
  const importer = new WooCommerceImporter();
  const orders = [
    {
      id: 999,
      status: 'trash',
      date_paid: '2024-01-01',
      currency: 'SAR',
      total: '100',
      total_tax: '0',
      shipping_total: '0',
      discount_total: '0',
    },
  ];
  t.throws(
    () => importer.parse(JSON.stringify(orders)),
    (err: unknown) =>
      err instanceof ImportValidationError &&
      /unsupported WooCommerce order status/.test(err.message),
    'throws ImportValidationError for unknown status "trash"'
  );
  t.end();
});

test('WooCommerceImporter: missing date throws ImportValidationError', (t) => {
  const importer = new WooCommerceImporter();
  const orders = [
    {
      id: 103,
      status: 'completed',
      currency: 'SAR',
      total: '100',
      total_tax: '0',
      shipping_total: '0',
      discount_total: '0',
    },
  ];
  t.throws(
    () => importer.parse(JSON.stringify(orders)),
    (err: unknown) =>
      err instanceof ImportValidationError &&
      /date.*missing/i.test(err.message),
    'throws ImportValidationError for missing date'
  );
  t.end();
});

test('WooCommerceImporter: invalid date throws ImportValidationError', (t) => {
  const importer = new WooCommerceImporter();
  const orders = [
    {
      id: 104,
      status: 'completed',
      date_paid: 'not-a-date',
      currency: 'SAR',
      total: '100',
      total_tax: '0',
      shipping_total: '0',
      discount_total: '0',
    },
  ];
  t.throws(
    () => importer.parse(JSON.stringify(orders)),
    (err: unknown) =>
      err instanceof ImportValidationError &&
      /date.*invalid/i.test(err.message),
    'throws ImportValidationError for invalid date'
  );
  t.end();
});

test('WooCommerceImporter: NaN amount throws ImportValidationError', (t) => {
  const importer = new WooCommerceImporter();
  const orders = [
    {
      id: 105,
      status: 'completed',
      date_paid: '2024-01-01T00:00:00',
      currency: 'SAR',
      total: 'not-a-number',
      total_tax: '0',
      shipping_total: '0',
      discount_total: '0',
    },
  ];
  t.throws(
    () => importer.parse(JSON.stringify(orders)),
    (err: unknown) =>
      err instanceof ImportValidationError &&
      /not a valid finite number/i.test(err.message),
    'throws ImportValidationError for NaN amount'
  );
  t.end();
});

// ── PSPExportImporter — valid cases ─────────────────────────────────────────

const pspRowsValid = [
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

test('PSPExportImporter: parses valid rows with decimal-string amounts', (t) => {
  const importer = new PSPExportImporter();
  const txns = importer.parse(JSON.stringify(pspRowsValid));

  t.equal(txns.length, 3, 'three rows');
  t.equal(txns[0].transactionType, 'payment', 'payment type');
  t.equal(txns[1].transactionType, 'refund', 'refund type');
  t.equal(txns[2].transactionType, 'chargeback', 'chargeback type');
  t.equal(txns[0].sourceId, 'TXN-001', 'sourceId from id field');
  // Amounts are decimal strings, not JS Numbers.
  t.equal(txns[0].fees, '9.00', 'fee is source string');
  t.equal(
    txns[0].netAmount,
    '289.65',
    'net is source string (explicitly provided)'
  );
  t.equal(txns[0].grossAmount, '300.00', 'gross is source string');
  t.end();
});

test('PSPExportImporter: uppercases currency', (t) => {
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
  const txns = importer.parse(JSON.stringify(rows));
  t.equal(txns[0].currency, 'SAR', 'currency uppercased');
  t.end();
});

test('PSPExportImporter: payout maps to settlement', (t) => {
  const importer = new PSPExportImporter();
  const rows = [
    {
      id: 'P1',
      type: 'payout',
      date: '2024-01-01',
      currency: 'SAR',
      gross: '1000',
      fee: '0',
      tax: '0',
      net: '1000',
    },
  ];
  const txns = importer.parse(JSON.stringify(rows));
  t.equal(txns[0].transactionType, 'settlement', 'payout → settlement');
  t.end();
});

test('PSPExportImporter: computed net when source net absent (pesa arithmetic)', (t) => {
  const importer = new PSPExportImporter();
  const rows = [
    // net field omitted — importer must compute gross − fee − tax via pesa
    {
      id: 'C1',
      type: 'payment',
      date: '2024-01-01',
      currency: 'SAR',
      gross: '300.00',
      fee: '9.00',
      tax: '1.35',
    },
  ];
  const txns = importer.parse(JSON.stringify(rows));
  // 300.00 − 9.00 − 1.35 = 289.65 → pesa stores as '289.650000'
  t.equal(
    txns[0].netAmount,
    '289.650000',
    'pesa-computed net has 6 decimal places'
  );
  t.end();
});

// ── PSPExportImporter — rejection cases ─────────────────────────────────────

test('PSPExportImporter: missing currency throws ImportValidationError', (t) => {
  const importer = new PSPExportImporter();
  const rows = [
    {
      id: 'C2',
      type: 'payment',
      date: '2024-01-01',
      gross: '100',
      fee: '0',
      tax: '0',
      net: '100',
    },
  ];
  t.throws(
    () => importer.parse(JSON.stringify(rows)),
    (err: unknown) =>
      err instanceof ImportValidationError &&
      /currency.*missing/i.test(err.message),
    'throws ImportValidationError when currency absent — no SAR default'
  );
  t.end();
});

test('PSPExportImporter: missing id throws ImportValidationError', (t) => {
  const importer = new PSPExportImporter();
  const rows = [
    // id omitted — must not fall back to psp-${idx}
    {
      type: 'payment',
      date: '2024-01-01',
      currency: 'SAR',
      gross: '100',
      fee: '0',
      tax: '0',
      net: '100',
    },
  ];
  t.throws(
    () => importer.parse(JSON.stringify(rows)),
    (err: unknown) =>
      err instanceof ImportValidationError &&
      /transaction id.*missing/i.test(err.message),
    'throws ImportValidationError for missing id — row index must not masquerade as source ID'
  );
  t.end();
});

test('PSPExportImporter: unknown type throws ImportValidationError (no silent fallback)', (t) => {
  const importer = new PSPExportImporter();
  const rows = [
    {
      id: 'X1',
      type: 'mystery_type',
      date: '2024-01-01',
      currency: 'SAR',
      gross: '100',
      fee: '0',
      tax: '0',
      net: '100',
    },
  ];
  t.throws(
    () => importer.parse(JSON.stringify(rows)),
    (err: unknown) =>
      err instanceof ImportValidationError &&
      /unsupported PSP transaction type/.test(err.message),
    'throws ImportValidationError for unknown PSP type'
  );
  t.end();
});

test('PSPExportImporter: missing type throws ImportValidationError', (t) => {
  const importer = new PSPExportImporter();
  const rows = [
    {
      id: 'X1',
      date: '2024-01-01',
      currency: 'SAR',
      gross: '100',
      fee: '0',
      tax: '0',
      net: '100',
    },
  ];
  t.throws(
    () => importer.parse(JSON.stringify(rows)),
    (err: unknown) =>
      err instanceof ImportValidationError &&
      /type.*missing/i.test(err.message),
    'throws for missing type'
  );
  t.end();
});

test('PSPExportImporter: missing date throws ImportValidationError', (t) => {
  const importer = new PSPExportImporter();
  const rows = [
    {
      id: 'X1',
      type: 'payment',
      currency: 'SAR',
      gross: '100',
      fee: '0',
      tax: '0',
      net: '100',
    },
  ];
  t.throws(
    () => importer.parse(JSON.stringify(rows)),
    (err: unknown) =>
      err instanceof ImportValidationError &&
      /date.*missing/i.test(err.message),
    'throws for missing date'
  );
  t.end();
});

test('PSPExportImporter: invalid date throws ImportValidationError', (t) => {
  const importer = new PSPExportImporter();
  const rows = [
    {
      id: 'X1',
      type: 'payment',
      date: 'not-a-date',
      currency: 'SAR',
      gross: '100',
      fee: '0',
      tax: '0',
      net: '100',
    },
  ];
  t.throws(
    () => importer.parse(JSON.stringify(rows)),
    (err: unknown) =>
      err instanceof ImportValidationError &&
      /date.*invalid/i.test(err.message),
    'throws for invalid date'
  );
  t.end();
});

test('PSPExportImporter: NaN gross throws ImportValidationError', (t) => {
  const importer = new PSPExportImporter();
  const rows = [
    {
      id: 'X1',
      type: 'payment',
      date: '2024-01-01',
      currency: 'SAR',
      gross: 'abc',
      fee: '0',
      tax: '0',
      net: '100',
    },
  ];
  t.throws(
    () => importer.parse(JSON.stringify(rows)),
    (err: unknown) =>
      err instanceof ImportValidationError &&
      /not a valid finite number/i.test(err.message),
    'throws for NaN gross amount'
  );
  t.end();
});

test('PSPExportImporter: string "Infinity" fee throws ImportValidationError', (t) => {
  const importer = new PSPExportImporter();
  const rows = [
    {
      id: 'X1',
      type: 'payment',
      date: '2024-01-01',
      currency: 'SAR',
      gross: '100',
      fee: 'Infinity',
      tax: '0',
      net: '100',
    },
  ];
  t.throws(
    () => importer.parse(JSON.stringify(rows)),
    (err: unknown) =>
      err instanceof ImportValidationError &&
      /not a valid finite number/i.test(err.message),
    'throws for string "Infinity" fee'
  );
  t.end();
});

test('PSPExportImporter: rejects non-array input', (t) => {
  const importer = new PSPExportImporter();
  t.throws(
    () => importer.parse('{}'),
    /must be a JSON array/,
    'throws for non-array'
  );
  t.end();
});

// ── BankStatementImporter — valid cases ─────────────────────────────────────

const bankRowsValid = [
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

test('BankStatementImporter: parses credit and debit rows with decimal-string amounts', (t) => {
  const importer = new BankStatementImporter('SAR');
  const txns = importer.parse(JSON.stringify(bankRowsValid));

  t.equal(txns.length, 2, 'two rows');
  t.equal(txns[0].transactionType, 'bank_credit', 'credit row');
  t.equal(txns[1].transactionType, 'bank_debit', 'debit row');
  // Amounts are decimal strings, not JS Numbers.
  t.equal(
    txns[0].grossAmount,
    '1500.00',
    'credit grossAmount is source string'
  );
  t.equal(
    txns[1].grossAmount,
    '800.00',
    'debit grossAmount is magnitude (positive source string)'
  );
  t.equal(txns[0].netAmount, '1500.00', 'credit net = credit amount');
  t.equal(txns[1].netAmount, '-800.000000', 'debit net is negated via pesa');
  t.equal(txns[0].sourceId, 'REF001', 'reference used as sourceId');
  t.end();
});

// ── Currency validation ───────────────────────────────────────────────────────

test('BankStatementImporter: explicit SAR currency preserved', (t) => {
  const importer = new BankStatementImporter('SAR');
  const txns = importer.parse(JSON.stringify(bankRowsValid));
  t.equal(txns[0].currency, 'SAR', 'SAR passed explicitly is preserved');
  t.end();
});

test('BankStatementImporter: explicit USD currency preserved', (t) => {
  const importer = new BankStatementImporter('USD');
  const txns = importer.parse(JSON.stringify(bankRowsValid));
  t.equal(txns[0].currency, 'USD', 'USD passed explicitly is preserved');
  t.end();
});

test('BankStatementImporter: explicit EUR currency preserved', (t) => {
  const importer = new BankStatementImporter('EUR');
  const txns = importer.parse(JSON.stringify(bankRowsValid));
  t.equal(txns[0].currency, 'EUR', 'EUR passed explicitly is preserved');
  t.end();
});

test('BankStatementImporter: missing currency throws at construction', (t) => {
  t.throws(
    () => new (BankStatementImporter as any)(),
    /requires an explicit currency/,
    'undefined currency throws immediately'
  );
  t.end();
});

test('BankStatementImporter: blank currency throws at construction', (t) => {
  t.throws(
    () => new BankStatementImporter(''),
    /must not be blank/,
    'blank string currency throws immediately'
  );
  t.end();
});

test('BankStatementImporter: whitespace-only currency throws at construction', (t) => {
  t.throws(
    () => new BankStatementImporter('   '),
    /must not be blank/,
    'whitespace-only currency throws immediately'
  );
  t.end();
});

test('BankStatementImporter: malformed currency throws at construction', (t) => {
  t.throws(
    () => new BankStatementImporter('usd'),
    /malformed/,
    'lowercase currency throws — must be 3 uppercase letters'
  );
  t.throws(
    () => new BankStatementImporter('DOLLARS'),
    /malformed/,
    'more than 3 letters throws'
  );
  t.throws(
    () => new BankStatementImporter('S1'),
    /malformed/,
    'non-letter character throws'
  );
  t.end();
});

// ── Row locator vs external ID ───────────────────────────────────────────────

test('BankStatementImporter: row without reference has empty sourceId, rowLocator in normalizedMeta', (t) => {
  const importer = new BankStatementImporter('SAR');
  const rows = [{ date: '2024-01-01', credit: '100.00', debit: '' }];
  const txns = importer.parse(JSON.stringify(rows));
  t.equal(
    txns[0].sourceId,
    '',
    'sourceId is empty string — no external ref invented'
  );
  t.equal(txns[0].normalizedMeta?.hasSourceRef, false, 'hasSourceRef false');
  t.equal(
    txns[0].normalizedMeta?.rowLocator,
    0,
    'rowLocator = row index (internal only)'
  );
  // rawData must not be augmented.
  t.equal(
    txns[0].rawData['_hasSourceRef'],
    undefined,
    '_hasSourceRef absent from rawData'
  );
  t.end();
});

test('BankStatementImporter: row with reference has sourceId = reference; rowLocator preserved', (t) => {
  const importer = new BankStatementImporter('SAR');
  const txns = importer.parse(JSON.stringify(bankRowsValid));
  t.equal(txns[0].sourceId, 'REF001', 'sourceId = bank reference exactly');
  t.equal(txns[0].normalizedMeta?.hasSourceRef, true, 'hasSourceRef true');
  t.equal(txns[0].normalizedMeta?.rowLocator, 0, 'rowLocator = row index');
  t.equal(
    txns[0].rawData['_hasSourceRef'],
    undefined,
    '_hasSourceRef absent from rawData'
  );
  t.end();
});

test('BankStatementImporter: rejects non-array input', (t) => {
  const importer = new BankStatementImporter('SAR');
  t.throws(
    () => importer.parse('{}'),
    /must be a JSON array/,
    'throws Error for non-array'
  );
  t.end();
});

// ── BankStatementImporter — rejection cases ──────────────────────────────────

test('BankStatementImporter: missing date throws ImportValidationError', (t) => {
  const importer = new BankStatementImporter('SAR');
  const rows = [{ credit: '100.00', debit: '', reference: 'REF999' }];
  t.throws(
    () => importer.parse(JSON.stringify(rows)),
    (err: unknown) =>
      err instanceof ImportValidationError &&
      /date.*missing/i.test(err.message),
    'throws for missing date'
  );
  t.end();
});

test('BankStatementImporter: invalid date throws ImportValidationError', (t) => {
  const importer = new BankStatementImporter('SAR');
  const rows = [
    { date: 'not-a-date', credit: '100.00', debit: '', reference: 'REF998' },
  ];
  t.throws(
    () => importer.parse(JSON.stringify(rows)),
    (err: unknown) =>
      err instanceof ImportValidationError &&
      /date.*invalid/i.test(err.message),
    'throws for invalid date'
  );
  t.end();
});

test('BankStatementImporter: zero-value row throws ImportValidationError', (t) => {
  const importer = new BankStatementImporter('SAR');
  const rows = [
    { date: '2024-01-01', credit: '0', debit: '0', reference: 'REF000' },
  ];
  t.throws(
    () => importer.parse(JSON.stringify(rows)),
    (err: unknown) =>
      err instanceof ImportValidationError &&
      /zero-value row/i.test(err.message),
    'throws for zero debit and zero credit'
  );
  t.end();
});

test('BankStatementImporter: ambiguous row (both non-zero) throws ImportValidationError', (t) => {
  const importer = new BankStatementImporter('SAR');
  const rows = [
    { date: '2024-01-01', credit: '100', debit: '50', reference: 'REFAMB' },
  ];
  t.throws(
    () => importer.parse(JSON.stringify(rows)),
    (err: unknown) =>
      err instanceof ImportValidationError &&
      /ambiguous row/i.test(err.message),
    'throws for non-zero debit AND non-zero credit'
  );
  t.end();
});

test('BankStatementImporter: NaN credit throws ImportValidationError', (t) => {
  const importer = new BankStatementImporter('SAR');
  const rows = [
    {
      date: '2024-01-01',
      credit: 'not-a-number',
      debit: '',
      reference: 'REF997',
    },
  ];
  t.throws(
    () => importer.parse(JSON.stringify(rows)),
    (err: unknown) =>
      err instanceof ImportValidationError &&
      /not a valid finite number/i.test(err.message),
    'throws for NaN credit amount'
  );
  t.end();
});

test('BankStatementImporter: string "Infinity" debit throws ImportValidationError', (t) => {
  const importer = new BankStatementImporter('SAR');
  const rows = [
    { date: '2024-01-01', credit: '', debit: 'Infinity', reference: 'REF996' },
  ];
  t.throws(
    () => importer.parse(JSON.stringify(rows)),
    (err: unknown) =>
      err instanceof ImportValidationError &&
      /not a valid finite number/i.test(err.message),
    'throws for string "Infinity" debit'
  );
  t.end();
});

// ── Decimal precision regression tests ───────────────────────────────────────

test('Decimal precision: 100.10 - 10.01 is exact via pesa (would be 90.08999... via JS float)', (t) => {
  // Prove that JS floating-point gives a wrong result, pesa gives the right one.
  const jsFloat = 100.1 - 10.01;
  t.notEqual(jsFloat, 90.09, 'JS float subtraction is imprecise for this pair');

  const importer = new PSPExportImporter();
  const rows = [
    // No explicit net — importer must compute via pesa.
    {
      id: 'PREC-1',
      type: 'payment',
      date: '2024-01-01',
      currency: 'SAR',
      gross: '100.10',
      fee: '10.01',
      tax: '0',
    },
  ];
  const txns = importer.parse(JSON.stringify(rows));
  // gross - fee - tax = 100.10 - 10.01 - 0 = 90.09 exactly
  t.equal(
    txns[0].netAmount,
    '90.090000',
    'pesa gives correct 90.09 (not float 90.08999...)'
  );
  t.end();
});

test('Decimal precision: large amount 123456789.99 preserved without floating-point loss', (t) => {
  const importer = new PSPExportImporter();
  const rows = [
    {
      id: 'LARGE-1',
      type: 'payment',
      date: '2024-01-01',
      currency: 'SAR',
      gross: '123456789.99',
      fee: '0',
      tax: '0',
      net: '123456789.99',
    },
  ];
  const txns = importer.parse(JSON.stringify(rows));
  // net is explicitly provided → returns original source string exactly.
  t.equal(
    txns[0].grossAmount,
    '123456789.99',
    'large gross preserved as source string'
  );
  t.equal(
    txns[0].netAmount,
    '123456789.99',
    'large net preserved as source string'
  );
  t.end();
});

test('Decimal precision: amounts are strings, never JS Numbers', (t) => {
  const pspImporter = new PSPExportImporter();
  const pspTxns = pspImporter.parse(JSON.stringify(pspRowsValid));
  t.equal(typeof pspTxns[0].grossAmount, 'string', 'PSP grossAmount is string');
  t.equal(typeof pspTxns[0].fees, 'string', 'PSP fees is string');
  t.equal(typeof pspTxns[0].netAmount, 'string', 'PSP netAmount is string');

  const wooImporter = new WooCommerceImporter();
  const wooTxns = wooImporter.parse(JSON.stringify(wooOrdersValid));
  t.equal(
    typeof wooTxns[0].grossAmount,
    'string',
    'WooCommerce grossAmount is string'
  );
  t.equal(typeof wooTxns[0].taxes, 'string', 'WooCommerce taxes is string');
  t.equal(
    typeof wooTxns[0].netAmount,
    'string',
    'WooCommerce netAmount is string'
  );

  const bankImporter = new BankStatementImporter('SAR');
  const bankTxns = bankImporter.parse(JSON.stringify(bankRowsValid));
  t.equal(
    typeof bankTxns[0].grossAmount,
    'string',
    'BankStatement grossAmount is string'
  );
  t.equal(
    typeof bankTxns[1].netAmount,
    'string',
    'BankStatement netAmount is string'
  );
  t.end();
});

// ── Idempotency: same raw data yields same hash ──────────────────────────────

test('evidenceHash idempotency: same WooCommerce order parsed twice gives identical hash', (t) => {
  const wooImporter = new WooCommerceImporter();
  const txns1 = wooImporter.parse(JSON.stringify(wooOrdersValid));
  const txns2 = wooImporter.parse(JSON.stringify(wooOrdersValid));

  const hash1 = computeEvidenceHash({
    sourceType: txns1[0].sourceType,
    sourceId: txns1[0].sourceId,
    raw: txns1[0].rawData,
  });
  const hash2 = computeEvidenceHash({
    sourceType: txns2[0].sourceType,
    sourceId: txns2[0].sourceId,
    raw: txns2[0].rawData,
  });
  t.equal(
    hash1,
    hash2,
    'same source data → identical evidence hash (idempotent)'
  );
  t.end();
});

test('evidenceHash: same sourceId from different sourceTypes produces different hashes', (t) => {
  const pspTxns = new PSPExportImporter().parse(
    JSON.stringify([
      {
        id: 'TXN-001',
        type: 'payment',
        date: '2024-01-20',
        currency: 'SAR',
        gross: '300',
        fee: '9',
        tax: '1.35',
        net: '289.65',
      },
    ])
  );
  const pspHash = computeEvidenceHash({
    sourceType: pspTxns[0].sourceType,
    sourceId: pspTxns[0].sourceId,
    raw: pspTxns[0].rawData,
  });
  const fakeWooHash = computeEvidenceHash({
    sourceType: 'woocommerce',
    sourceId: 'TXN-001',
    raw: pspTxns[0].rawData,
  });
  t.notEqual(
    pspHash,
    fakeWooHash,
    'same sourceId + raw data but different sourceType → different hashes'
  );
  t.end();
});

test('computeFileHash vs computeEvidenceHash are distinct operations', (t) => {
  const sourceContent = JSON.stringify(wooOrdersValid);
  const fileHash = computeFileHash(sourceContent);
  const wooImporter = new WooCommerceImporter();
  const txns = wooImporter.parse(sourceContent);
  const evidenceHash = computeEvidenceHash({
    sourceType: txns[0].sourceType,
    sourceId: txns[0].sourceId,
    raw: txns[0].rawData,
  });
  t.equal(fileHash.length, 64, 'file hash is SHA-256 hex');
  t.equal(evidenceHash.length, 64, 'evidence hash is SHA-256 hex');
  t.notEqual(
    fileHash,
    evidenceHash,
    'file hash ≠ evidence hash (different inputs)'
  );
  t.end();
});

// ── rawData integrity: no augmentation ───────────────────────────────────────

test('rawData must equal the original source object — no synthetic keys', (t) => {
  const order = {
    id: 800,
    status: 'completed',
    date_paid: '2024-01-01T00:00:00',
    currency: 'USD',
    total: '50.00',
    total_tax: '5.00',
    shipping_total: '3.00',
    discount_total: '2.00',
  };
  const importer = new WooCommerceImporter();
  const txns = importer.parse(JSON.stringify([order]));
  const rawKeys = Object.keys(txns[0].rawData).sort();
  const sourceKeys = Object.keys(order).sort();
  t.deepEqual(
    rawKeys,
    sourceKeys,
    'rawData keys are exactly the source keys — no added synthetic keys'
  );
  t.end();
});

// ── Bank: pesa-based zero/sign comparisons (Issue 5) ─────────────────────────

test('BankStatementImporter: pesa zero-comparison — amount 0 is zero', (t) => {
  const importer = new BankStatementImporter('SAR');
  t.throws(
    () =>
      importer.parse(
        JSON.stringify([{ date: '2024-01-01', debit: 0, credit: 0 }])
      ),
    /zero-value row/,
    'both-zero row throws (pesa zero check, not Number())'
  );
  t.end();
});

test('BankStatementImporter: pesa zero-comparison — 0.000001 is non-zero', (t) => {
  const importer = new BankStatementImporter('SAR');
  const txns = importer.parse(
    JSON.stringify([
      { date: '2024-01-01', credit: '0.000001', reference: 'T1' },
    ])
  );
  t.equal(
    txns[0].grossAmount,
    '0.000001',
    'sub-cent amount preserved as string'
  );
  t.equal(txns[0].transactionType, 'bank_credit', 'direction correct via pesa');
  t.end();
});

test('BankStatementImporter: pesa zero-comparison — 0.1 credit recognised', (t) => {
  const importer = new BankStatementImporter('SAR');
  const txns = importer.parse(
    JSON.stringify([{ date: '2024-01-01', credit: '0.1', reference: 'T2' }])
  );
  t.equal(txns[0].grossAmount, '0.1', 'grossAmount is source string');
  t.equal(txns[0].transactionType, 'bank_credit', 'direction is credit');
  t.end();
});

test('BankStatementImporter: pesa zero-comparison — 0.01 debit recognised', (t) => {
  const importer = new BankStatementImporter('SAR');
  const txns = importer.parse(
    JSON.stringify([{ date: '2024-01-01', debit: '0.01', reference: 'T3' }])
  );
  t.equal(txns[0].grossAmount, '0.01', 'grossAmount is source string');
  t.equal(txns[0].transactionType, 'bank_debit', 'direction is debit');
  t.end();
});

test('BankStatementImporter: large credit 123456789.99 preserved without float loss', (t) => {
  const importer = new BankStatementImporter('SAR');
  const txns = importer.parse(
    JSON.stringify([
      { date: '2024-01-01', credit: '123456789.99', reference: 'BIG-1' },
    ])
  );
  t.equal(
    txns[0].grossAmount,
    '123456789.99',
    'large amount preserved as source string'
  );
  t.equal(txns[0].netAmount, '123456789.99', 'net equals gross for credit');
  t.end();
});

test('BankStatementImporter: large debit 999999999999.999999 preserved without float loss', (t) => {
  const importer = new BankStatementImporter('SAR');
  const txns = importer.parse(
    JSON.stringify([
      { date: '2024-01-01', debit: '999999999999.999999', reference: 'BIG-2' },
    ])
  );
  t.equal(
    txns[0].grossAmount,
    '999999999999.999999',
    'large debit amount preserved as source string'
  );
  t.equal(txns[0].transactionType, 'bank_debit', 'direction is debit');
  t.end();
});

test('BankStatementImporter: ambiguous row (both non-zero) throws via pesa comparison', (t) => {
  const importer = new BankStatementImporter('SAR');
  t.throws(
    () =>
      importer.parse(
        JSON.stringify([
          {
            date: '2024-01-01',
            debit: '100.00',
            credit: '50.00',
            reference: 'AMB-1',
          },
        ])
      ),
    /ambiguous row/,
    'both-nonzero throws (direction determined via pesa isZero)'
  );
  t.end();
});

test('BankStatementImporter: invalid/non-finite/garbage value throws', (t) => {
  const importer = new BankStatementImporter('SAR');
  t.throws(
    () =>
      importer.parse(
        JSON.stringify([
          { date: '2024-01-01', credit: 'garbage', reference: 'BAD-1' },
        ])
      ),
    /not a valid finite number/,
    'non-numeric credit throws'
  );
  t.throws(
    () =>
      importer.parse(
        JSON.stringify([
          { date: '2024-01-01', debit: 'Infinity', reference: 'BAD-2' },
        ])
      ),
    /not a valid finite number/,
    'Infinity string throws'
  );
  t.throws(
    () =>
      importer.parse(
        JSON.stringify([
          { date: '2024-01-01', credit: 'NaN', reference: 'BAD-3' },
        ])
      ),
    /not a valid finite number/,
    'NaN string throws'
  );
  t.end();
});

// ── Bank identity: row locator vs external ID ─────────────────────────────────

test('BankStatementImporter: same row index in different files does not collide if rawData differs', (t) => {
  const importer = new BankStatementImporter('SAR');
  const file1 = [{ date: '2024-01-01', credit: '100', debit: '' }];
  const file2 = [{ date: '2024-02-01', credit: '200', debit: '' }];
  const txn1 = importer.parse(JSON.stringify(file1))[0];
  const txn2 = importer.parse(JSON.stringify(file2))[0];
  // Same rowLocator (0) but different rawData → different evidence hashes.
  const {
    computeEvidenceHash,
  } = require('../duhgoods/evidence/EvidenceManager');
  const h1 = computeEvidenceHash({
    sourceType: txn1.sourceType,
    sourceId: txn1.sourceId,
    raw: txn1.rawData,
  });
  const h2 = computeEvidenceHash({
    sourceType: txn2.sourceType,
    sourceId: txn2.sourceId,
    raw: txn2.rawData,
  });
  t.notEqual(
    h1,
    h2,
    'same row index, different rawData → different evidence hashes'
  );
  t.end();
});

test('BankStatementImporter: same external reference in different source accounts must use different source namespace', (t) => {
  // The importer itself cannot enforce cross-account isolation — that is the
  // orchestrator's responsibility via its sourceName/sourceType scoping.
  // What the importer MUST do is set sourceId = the raw reference exactly.
  const importer = new BankStatementImporter('SAR');
  const rows = [{ date: '2024-01-01', credit: '500', reference: 'TXN-SAME' }];
  const txns = importer.parse(JSON.stringify(rows));
  t.equal(
    txns[0].sourceId,
    'TXN-SAME',
    'sourceId is the bank reference exactly'
  );
  t.end();
});

// ── Idempotency: reference-less rows use rawData for identity ─────────────────

test('BankStatementImporter: reference-less row parsed twice gives same evidence hash', (t) => {
  const importer = new BankStatementImporter('SAR');
  const rows = [{ date: '2024-01-01', credit: '75.50' }];
  const txn1 = importer.parse(JSON.stringify(rows))[0];
  const txn2 = importer.parse(JSON.stringify(rows))[0];
  const {
    computeEvidenceHash: computeEvidenceHashRequire,
  } = require('../duhgoods/evidence/EvidenceManager');
  const h1 = computeEvidenceHashRequire({
    sourceType: txn1.sourceType,
    sourceId: txn1.sourceId,
    raw: txn1.rawData,
  });
  const h2 = computeEvidenceHashRequire({
    sourceType: txn2.sourceType,
    sourceId: txn2.sourceId,
    raw: txn2.rawData,
  });
  t.equal(
    h1,
    h2,
    'reference-less row produces idempotent evidence hash via rawData'
  );
  t.end();
});

// ── computeIdentityKey: collision-prevention tests ───────────────────────────

test('computeIdentityKey: same ref + same namespace → same key', (t) => {
  const k1 = computeIdentityKey({
    sourceType: 'bank_statement',
    sourceNamespace: 'bank:SNB:SAR:IBAN1234',
    externalSourceId: 'TXN-001',
  });
  const k2 = computeIdentityKey({
    sourceType: 'bank_statement',
    sourceNamespace: 'bank:SNB:SAR:IBAN1234',
    externalSourceId: 'TXN-001',
  });
  t.equal(k1, k2, 'identical inputs produce identical identity key');
  t.equal(k1.length, 64, 'SHA-256 hex is 64 chars');
  t.end();
});

test('computeIdentityKey: same ref from different accounts (collision class A) → different keys', (t) => {
  const acctA = computeIdentityKey({
    sourceType: 'bank_statement',
    sourceNamespace: 'bank:SNB:SAR:IBAN1234',
    externalSourceId: 'TXN-001',
  });
  const acctB = computeIdentityKey({
    sourceType: 'bank_statement',
    sourceNamespace: 'bank:RJHI:SAR:IBAN5678',
    externalSourceId: 'TXN-001',
  });
  t.notEqual(
    acctA,
    acctB,
    'same external ref from different accounts → different identity keys (collision A prevented)'
  );
  t.end();
});

test('computeIdentityKey: same ref across different source types (collision class B) → different keys', (t) => {
  const bank = computeIdentityKey({
    sourceType: 'bank_statement',
    sourceNamespace: 'bank:SNB:SAR:IBAN1234',
    externalSourceId: 'TXN-001',
  });
  const psp = computeIdentityKey({
    sourceType: 'psp_export',
    sourceNamespace: 'bank:SNB:SAR:IBAN1234',
    externalSourceId: 'TXN-001',
  });
  t.notEqual(
    bank,
    psp,
    'same ref + same namespace but different sourceType → different identity keys (collision B prevented)'
  );
  t.end();
});

test('computeIdentityKey: reference-less rows in different files (collision class C) → different keys', (t) => {
  const fileHash1 = computeFileHash('file-contents-A');
  const fileHash2 = computeFileHash('file-contents-B');
  const k1 = computeIdentityKey({
    sourceType: 'bank_statement',
    sourceNamespace: 'bank:SNB:SAR:IBAN1234',
    externalSourceId: '',
    sourceFileHash: fileHash1,
    rowLocator: 0,
  });
  const k2 = computeIdentityKey({
    sourceType: 'bank_statement',
    sourceNamespace: 'bank:SNB:SAR:IBAN1234',
    externalSourceId: '',
    sourceFileHash: fileHash2,
    rowLocator: 0,
  });
  t.notEqual(
    k1,
    k2,
    'same row position in different import files → different identity keys (collision C prevented)'
  );
  t.end();
});

test('computeIdentityKey: reference-less rows in same file at different positions → different keys', (t) => {
  const fileHash = computeFileHash('same-file-contents');
  const k1 = computeIdentityKey({
    sourceType: 'bank_statement',
    sourceNamespace: 'bank:SNB:SAR:IBAN1234',
    externalSourceId: '',
    sourceFileHash: fileHash,
    rowLocator: 0,
  });
  const k2 = computeIdentityKey({
    sourceType: 'bank_statement',
    sourceNamespace: 'bank:SNB:SAR:IBAN1234',
    externalSourceId: '',
    sourceFileHash: fileHash,
    rowLocator: 1,
  });
  t.notEqual(
    k1,
    k2,
    'same file, different row positions → different identity keys'
  );
  t.end();
});

test('computeIdentityKey: reference-less rows in same file at same position → same key (idempotent)', (t) => {
  const fileHash = computeFileHash('same-file-contents');
  const k1 = computeIdentityKey({
    sourceType: 'bank_statement',
    sourceNamespace: 'bank:SNB:SAR:IBAN1234',
    externalSourceId: '',
    sourceFileHash: fileHash,
    rowLocator: 0,
  });
  const k2 = computeIdentityKey({
    sourceType: 'bank_statement',
    sourceNamespace: 'bank:SNB:SAR:IBAN1234',
    externalSourceId: '',
    sourceFileHash: fileHash,
    rowLocator: 0,
  });
  t.equal(
    k1,
    k2,
    'same position in same file → identical identity key (idempotent reimport)'
  );
  t.end();
});

// ── Decimal regex: strict grammar rejects scientific notation ─────────────────

test('BankStatementImporter: scientific notation "1e5" rejected by strict decimal regex', (t) => {
  const importer = new BankStatementImporter('SAR');
  t.throws(
    () =>
      importer.parse(
        JSON.stringify([
          { date: '2024-01-01', credit: '1e5', reference: 'SCI-1' },
        ])
      ),
    /not a valid finite number/,
    'scientific notation "1e5" must be rejected — not a valid decimal'
  );
  t.end();
});

test('PSPExportImporter: scientific notation "2.5e3" rejected by strict decimal regex', (t) => {
  const importer = new PSPExportImporter();
  t.throws(
    () =>
      importer.parse(
        JSON.stringify([
          {
            id: 'SCI-PSP-1',
            type: 'payment',
            date: '2024-01-01',
            currency: 'SAR',
            gross: '2.5e3',
            fee: '0',
            tax: '0',
            net: '2.5e3',
          },
        ])
      ),
    /not a valid finite number/,
    'scientific notation "2.5e3" must be rejected in PSP importer'
  );
  t.end();
});

// ── Bank: negative debit/credit values ───────────────────────────────────────

test('BankStatementImporter: negative debit magnitude rejected', (t) => {
  const importer = new BankStatementImporter('SAR');
  t.throws(
    () =>
      importer.parse(
        JSON.stringify([
          { date: '2024-01-01', debit: '-500', reference: 'NEG-DEB-1' },
        ])
      ),
    /debit must be a non-negative magnitude/,
    'negative debit "-500" must be rejected — debit is a magnitude, direction comes from the column'
  );
  t.end();
});

test('BankStatementImporter: negative credit magnitude rejected', (t) => {
  const importer = new BankStatementImporter('SAR');
  t.throws(
    () =>
      importer.parse(
        JSON.stringify([
          { date: '2024-01-01', credit: '-200', reference: 'NEG-CR-1' },
        ])
      ),
    /credit must be a non-negative magnitude/,
    'negative credit "-200" must be rejected'
  );
  t.end();
});

test('BankStatementImporter: zero debit + zero credit still rejected', (t) => {
  const importer = new BankStatementImporter('SAR');
  t.throws(
    () =>
      importer.parse(
        JSON.stringify([
          { date: '2024-01-01', debit: '0', credit: '0', reference: 'ZERO-1' },
        ])
      ),
    /zero-value row/,
    'both-zero row still rejected'
  );
  t.end();
});

test('BankStatementImporter: both positive debit and credit still rejected', (t) => {
  const importer = new BankStatementImporter('SAR');
  t.throws(
    () =>
      importer.parse(
        JSON.stringify([
          {
            date: '2024-01-01',
            debit: '100',
            credit: '50',
            reference: 'AMB-1',
          },
        ])
      ),
    /ambiguous row/,
    'both-positive debit+credit still rejected as ambiguous'
  );
  t.end();
});

test('BankStatementImporter: positive debit accepted', (t) => {
  const importer = new BankStatementImporter('SAR');
  const txns = importer.parse(
    JSON.stringify([
      { date: '2024-01-01', debit: '300', reference: 'POSDEBIT-1' },
    ])
  );
  t.equal(txns.length, 1, 'one transaction');
  t.equal(txns[0].transactionType, 'bank_debit', 'type is bank_debit');
  t.equal(txns[0].grossAmount, '300', 'grossAmount = magnitude');
  t.end();
});

// ── ImportOrchestrator: sourceNamespace validation ───────────────────────────

test('ImportOrchestrator: empty sourceNamespace rejected before any DB write', async (t) => {
  const fyo = getTestFyo();
  await setupInstance(getTestDbPath(), getTestSetupWizardOptions(), fyo);

  const importer = new BankStatementImporter('SAR');
  const orchestrator = new ImportOrchestrator(fyo, importer);

  let caughtErr: Error | null = null;
  try {
    await orchestrator.import(
      JSON.stringify([
        { date: '2024-01-01', credit: '100', reference: 'NS-1' },
      ]),
      { sourceName: 'Test', sourceNamespace: '' }
    );
  } catch (err) {
    caughtErr = err instanceof Error ? err : new Error(String(err));
  }

  t.ok(caughtErr, 'empty sourceNamespace throws');
  t.ok(
    /sourceNamespace must not be blank/i.test(caughtErr?.message ?? ''),
    `error mentions sourceNamespace (got: ${caughtErr?.message ?? '(none)'})`
  );

  // Verify NO ImportSource record was written to the DB.
  const sources = await fyo.db.getAll('DuhGoodsImportSource', {
    fields: ['name'],
  });
  t.equal(
    sources.length,
    0,
    'no ImportSource record created on namespace validation failure'
  );

  await fyo.close();
  t.end();
});

test('ImportOrchestrator: whitespace-only sourceNamespace rejected', async (t) => {
  const fyo = getTestFyo();
  await setupInstance(getTestDbPath(), getTestSetupWizardOptions(), fyo);

  const importer = new BankStatementImporter('SAR');
  const orchestrator = new ImportOrchestrator(fyo, importer);

  let caughtErr: Error | null = null;
  try {
    await orchestrator.import(
      JSON.stringify([
        { date: '2024-01-01', credit: '100', reference: 'NS-2' },
      ]),
      { sourceName: 'Test', sourceNamespace: '   ' }
    );
  } catch (err) {
    caughtErr = err instanceof Error ? err : new Error(String(err));
  }

  t.ok(caughtErr, 'whitespace sourceNamespace throws');
  t.ok(
    /sourceNamespace must not be blank/i.test(caughtErr?.message ?? ''),
    'error mentions sourceNamespace'
  );

  await fyo.close();
  t.end();
});

// ── ImportOrchestrator: batch audit counts ────────────────────────────────────

test('ImportOrchestrator: parse failure sets errorCount=1, status=failed', async (t) => {
  const fyo = getTestFyo();
  await setupInstance(getTestDbPath(), getTestSetupWizardOptions(), fyo);

  const importer = new BankStatementImporter('SAR');
  const orchestrator = new ImportOrchestrator(fyo, importer);

  const result = await orchestrator.import('not-json', {
    sourceName: 'Parse Fail',
    sourceNamespace: 'bank:TEST:PARSE',
  });

  t.equal(result.imported, 0, 'imported = 0 on parse failure');
  t.equal(result.errors.length, 1, 'one error recorded');

  const sources = await fyo.db.getAll('DuhGoodsImportSource', {
    filters: { name: result.sourceId },
    fields: ['status', 'errorCount', 'recordCount'],
    limit: 1,
  });
  t.equal(sources.length, 1, 'ImportSource record created');
  t.equal(sources[0].status, 'failed', 'status = failed');
  t.equal(Number(sources[0].errorCount), 1, 'errorCount = 1 on parse failure');
  t.equal(
    Number(sources[0].recordCount),
    0,
    'recordCount = 0 on parse failure'
  );

  await fyo.close();
  t.end();
});

test('ImportOrchestrator: changed evidence produces exception outcome and exceptionCount', async (t) => {
  const fyo = getTestFyo();
  await setupInstance(getTestDbPath(), getTestSetupWizardOptions(), fyo);

  const importer = new BankStatementImporter('SAR');
  const orchestrator = new ImportOrchestrator(fyo, importer);

  const ns = 'bank:EXCEPTION:TEST';

  // First import.
  const r1 = await orchestrator.import(
    JSON.stringify([
      { date: '2024-03-01', credit: '700', reference: 'EX-REF-001' },
    ]),
    { sourceName: 'Exception Test 1', sourceNamespace: ns }
  );
  t.equal(r1.imported, 1, 'first import: 1 imported');
  t.equal(r1.exceptions, 0, 'first import: 0 exceptions');

  // Second import — same reference but different amount (changed evidence).
  const r2 = await orchestrator.import(
    JSON.stringify([
      { date: '2024-03-01', credit: '750', reference: 'EX-REF-001' },
    ]),
    { sourceName: 'Exception Test 2', sourceNamespace: ns }
  );
  t.equal(r2.imported, 0, 'second import: 0 imported (not new evidence)');
  t.equal(r2.exceptions, 1, 'second import: 1 exception (changed evidence)');
  t.equal(r2.errors.length, 0, 'second import: 0 errors');

  // Batch status must not be 'imported' when there are exceptions.
  const src2 = await fyo.db.getAll('DuhGoodsImportSource', {
    filters: { name: r2.sourceId },
    fields: ['status', 'exceptionCount'],
    limit: 1,
  });
  t.notEqual(
    src2[0].status,
    'imported',
    'batch with exception must not report status=imported'
  );
  t.equal(Number(src2[0].exceptionCount), 1, 'exceptionCount = 1');

  await fyo.close();
  t.end();
});

// ── DuhGoodsImportRecord: complete financial field immutability ───────────────

test('DuhGoodsImportRecord: financial fields are immutable after insert', async (t) => {
  const fyo = getTestFyo();
  await setupInstance(getTestDbPath(), getTestSetupWizardOptions(), fyo);

  const sourceDoc = fyo.doc.getNewDoc('DuhGoodsImportSource');
  sourceDoc.sourceName = 'Immutable Financial Test';
  sourceDoc.sourceNamespace = 'bank:IMMUTABLE:FIN';
  sourceDoc.sourceType = 'bank_statement';
  sourceDoc.importedAt = new Date();
  sourceDoc.sourceHash = '9'.repeat(64);
  sourceDoc.recordCount = 1;
  sourceDoc.importedCount = 1;
  sourceDoc.skippedCount = 0;
  sourceDoc.exceptionCount = 0;
  sourceDoc.errorCount = 0;
  sourceDoc.status = 'imported';
  await sourceDoc.sync();

  const ns = 'bank:IMMUTABLE:FIN';
  const externalId = 'IMM-FIN-001';
  const identityKey = computeIdentityKey({
    sourceType: 'bank_statement',
    sourceNamespace: ns,
    externalSourceId: externalId,
  });
  const evidenceHash = computeEvidenceHash({
    identityKey,
    raw: { ref: externalId },
  });

  const recordDoc = fyo.doc.getNewDoc('DuhGoodsImportRecord');
  recordDoc.importSource = sourceDoc.name;
  recordDoc.sourceType = 'bank_statement';
  recordDoc.sourceNamespace = ns;
  recordDoc.sourceId = externalId;
  recordDoc.identityKey = identityKey;
  recordDoc.rowLocator = 0;
  recordDoc.transactionType = 'bank_credit';
  recordDoc.transactionDate = new Date('2024-06-01');
  recordDoc.currency = 'SAR';
  recordDoc.grossAmount = fyo.pesa('1000.00');
  recordDoc.fees = fyo.pesa('0');
  recordDoc.taxes = fyo.pesa('0');
  recordDoc.netAmount = fyo.pesa('1000.00');
  recordDoc.status = 'pending';
  recordDoc.rawData = JSON.stringify({ ref: externalId });
  recordDoc.evidenceHash = evidenceHash;
  recordDoc.evidenceVersion = 1;
  recordDoc.priorEvidenceHash = '';
  await recordDoc.sync();
  t.ok(recordDoc.name, 'record inserted');

  // Load same record and attempt to mutate grossAmount.
  const loaded = await fyo.doc.getDoc(
    'DuhGoodsImportRecord',
    recordDoc.name as string
  );
  loaded.grossAmount = fyo.pesa('9999.00');

  let immutableErr: Error | null = null;
  try {
    await loaded.sync();
  } catch (err) {
    immutableErr = err instanceof Error ? err : new Error(String(err));
  }
  t.ok(immutableErr, 'mutating grossAmount throws');
  t.ok(
    /evidence-immutable/i.test(immutableErr?.message ?? ''),
    `error mentions evidence-immutable (got: ${
      immutableErr?.message ?? '(none)'
    })`
  );

  // status and notes must remain mutable.
  // fyo.doc.getDoc returns a cached instance; reset the in-memory mutation so
  // the immutability check sees the original value, then update only mutable fields.
  loaded.grossAmount = fyo.pesa('1000.00');
  const loaded2 = loaded;
  loaded2.status = 'reconciled';
  loaded2.notes = 'Verified by auditor';
  let mutErr: Error | null = null;
  try {
    await loaded2.sync();
  } catch (err) {
    mutErr = err instanceof Error ? err : new Error(String(err));
  }
  t.notOk(mutErr, 'status and notes remain mutable after insert');

  await fyo.close();
  t.end();
});

// ── DuhGoodsImportSource: provenance immutability ────────────────────────────

test('DuhGoodsImportSource: provenance fields are immutable after insert', async (t) => {
  const fyo = getTestFyo();
  await setupInstance(getTestDbPath(), getTestSetupWizardOptions(), fyo);

  const now = new Date('2024-06-01T10:00:00Z');

  async function makeSource() {
    const doc = fyo.doc.getNewDoc('DuhGoodsImportSource');
    doc.sourceName = 'Provenance Test Source';
    doc.sourceNamespace = 'bank:PROV:SAR:TEST';
    doc.sourceType = 'bank_statement';
    doc.importedAt = now;
    doc.sourceFile = 'test.csv';
    doc.sourceHash = 'a'.repeat(64);
    doc.recordCount = 0;
    doc.importedCount = 0;
    doc.skippedCount = 0;
    doc.exceptionCount = 0;
    doc.errorCount = 0;
    doc.status = 'pending';
    await doc.sync();
    return doc;
  }

  const IMMUTABLE_CASES: Array<{
    field: string;
    mutate: (d: ReturnType<typeof fyo.doc.getNewDoc>) => void;
  }> = [
    {
      field: 'sourceName',
      mutate: (d) => {
        d.sourceName = 'Changed Name';
      },
    },
    {
      field: 'sourceNamespace',
      mutate: (d) => {
        d.sourceNamespace = 'bank:CHANGED';
      },
    },
    {
      field: 'sourceType',
      mutate: (d) => {
        d.sourceType = 'psp_export';
      },
    },
    {
      field: 'importedAt',
      mutate: (d) => {
        d.importedAt = new Date('2099-01-01');
      },
    },
    {
      field: 'sourceFile',
      mutate: (d) => {
        d.sourceFile = 'changed.csv';
      },
    },
    {
      field: 'sourceHash',
      mutate: (d) => {
        d.sourceHash = 'b'.repeat(64);
      },
    },
  ];

  for (const { field, mutate } of IMMUTABLE_CASES) {
    const src = await makeSource();
    const loaded = await fyo.doc.getDoc(
      'DuhGoodsImportSource',
      src.name as string
    );
    mutate(loaded);
    let err: Error | null = null;
    try {
      await loaded.sync();
    } catch (e) {
      err = e instanceof Error ? e : new Error(String(e));
    }
    t.ok(err, `mutating "${field}" throws`);
    t.ok(
      /provenance-immutable/i.test(err?.message ?? ''),
      `"${field}" error mentions provenance-immutable (got: ${
        err?.message ?? '(none)'
      })`
    );
  }

  // Mutable fields must still accept updates.
  const mutableSrc = await makeSource();
  const mutableLoaded = await fyo.doc.getDoc(
    'DuhGoodsImportSource',
    mutableSrc.name as string
  );
  mutableLoaded.status = 'imported';
  mutableLoaded.recordCount = 5;
  mutableLoaded.importedCount = 4;
  mutableLoaded.skippedCount = 1;
  mutableLoaded.exceptionCount = 0;
  mutableLoaded.errorCount = 0;
  mutableLoaded.errorSummary = 'none';
  let mutableErr: Error | null = null;
  try {
    await mutableLoaded.sync();
  } catch (e) {
    mutableErr = e instanceof Error ? e : new Error(String(e));
  }
  t.notOk(mutableErr, 'mutable audit-count and status fields can be updated');

  await fyo.close();
  t.end();
});

// ── ImportOrchestrator: concurrent evidence-version race retry ────────────────

test('ImportOrchestrator: concurrent evidence-version race — retry succeeds at version+1', async (t) => {
  // File-backed DB so a second DatabaseManager connection can inject the racing
  // record between the orchestrator's read and write in the exception path.
  const raceTempPath = path.join(os.tmpdir(), `dghir-race-${Date.now()}.db`);

  const fyo = getTestFyo();
  await setupInstance(raceTempPath, getTestSetupWizardOptions(), fyo);

  const injectorDm = new DatabaseManager();
  await injectorDm.connectToDatabase(raceTempPath);
  const injKnex = injectorDm.db!.knex!;

  const ns = 'bank:RACE:SAR';
  let raceInjected = false;

  class RaceOrchestrator extends ImportOrchestrator {
    protected override async _insertRecord(
      txn: ImportedTransaction,
      meta: InsertRecordMeta
    ) {
      if (
        !raceInjected &&
        meta.status === 'exception' &&
        meta.evidenceVersion === 2
      ) {
        raceInjected = true;
        const now = new Date().toISOString();
        await injKnex('DuhGoodsImportRecord').insert({
          name: 'race-winner-v2',
          created: now,
          modified: now,
          createdBy: '__SYSTEM__',
          modifiedBy: '__SYSTEM__',
          importSource: meta.importSourceId,
          sourceType: txn.sourceType,
          sourceNamespace: meta.sourceNamespace,
          sourceId: 'RACE-WINNER',
          identityKey: meta.identityKey,
          rowLocator: 0,
          transactionType: txn.transactionType,
          transactionDate: now,
          currency: txn.currency,
          grossAmount: txn.grossAmount,
          fees: txn.fees,
          taxes: txn.taxes,
          netAmount: txn.netAmount,
          status: 'exception',
          rawData: '{"race":"winner"}',
          evidenceHash: 'a'.repeat(64),
          evidenceVersion: 2,
          priorEvidenceHash: meta.priorEvidenceHash,
          notes: null,
        });
      }
      return super._insertRecord(txn, meta);
    }
  }

  function makeTxnAdapter(txns: ImportedTransaction[]) {
    return {
      sourceType: 'bank_statement' as const,
      parse: () => txns,
    };
  }

  const txn1: ImportedTransaction = {
    sourceId: 'RACE-REF-001',
    sourceType: 'bank_statement',
    transactionType: 'bank_credit',
    transactionDate: new Date('2024-01-15'),
    currency: 'SAR',
    grossAmount: '100.00',
    fees: '0.00',
    taxes: '0.00',
    netAmount: '100.00',
    rawData: { ref: 'RACE-REF-001', amount: 100 },
  };

  const r1 = await new ImportOrchestrator(fyo, makeTxnAdapter([txn1])).import(
    Buffer.from(''),
    {
      sourceName: 'Race Import 1',
      sourceNamespace: ns,
      sourceFile: 'race1.csv',
    }
  );
  t.equal(r1.imported, 1, 'first import: 1 imported (version 1)');
  t.equal(r1.errors.length, 0, 'first import: no errors');

  const txn2: ImportedTransaction = {
    ...txn1,
    rawData: { ref: 'RACE-REF-001', amount: 150 },
  };
  const r2 = await new RaceOrchestrator(fyo, makeTxnAdapter([txn2])).import(
    Buffer.from(''),
    {
      sourceName: 'Race Import 2',
      sourceNamespace: ns,
      sourceFile: 'race2.csv',
    }
  );

  t.ok(raceInjected, 'race injection was triggered');
  t.equal(r2.exceptions, 1, 'second import: 1 exception (retry at version 3)');
  t.equal(r2.errors.length, 0, 'second import: no errors after retry');

  const identityKey = computeIdentityKey({
    sourceType: 'bank_statement',
    sourceNamespace: ns,
    externalSourceId: 'RACE-REF-001',
  });
  const allVersions = await fyo.db.getAll('DuhGoodsImportRecord', {
    filters: { identityKey },
    fields: ['name', 'evidenceVersion', 'evidenceHash', 'status'],
    orderBy: 'evidenceVersion',
    order: 'asc',
  });

  t.equal(
    allVersions.length,
    3,
    'three versions in DB (v1, v2 race-winner, v3 retry)'
  );
  t.equal(
    Number(allVersions[2].evidenceVersion),
    3,
    'version 3 created by retry'
  );
  t.equal(allVersions[2].status, 'exception', 'version 3 status=exception');

  await fyo.close();
  await injectorDm.db!.close();
  for (const f of [
    raceTempPath,
    `${raceTempPath}-wal`,
    `${raceTempPath}-shm`,
  ]) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
  t.end();
});

test('ImportOrchestrator: concurrent first-insert race with different evidence — both evidences preserved', async (t) => {
  const raceTempPath = path.join(
    os.tmpdir(),
    `dghir-first-race-${Date.now()}.db`
  );
  const fyo = getTestFyo();
  await setupInstance(raceTempPath, getTestSetupWizardOptions(), fyo);

  const injectorDm = new DatabaseManager();
  await injectorDm.connectToDatabase(raceTempPath);
  const injKnex = injectorDm.db!.knex!;

  const ns = 'bank:FIRSTRACE:SAR';
  let raceInjected = false;

  class RaceFirstInsertOrchestrator extends ImportOrchestrator {
    protected override async _insertRecord(
      txn: ImportedTransaction,
      meta: InsertRecordMeta
    ) {
      if (
        !raceInjected &&
        meta.status === 'pending' &&
        meta.evidenceVersion === 1
      ) {
        raceInjected = true;
        const now = new Date().toISOString();
        const winnerEvidenceHash = computeEvidenceHash({
          identityKey: meta.identityKey,
          raw: { ref: 'FIRSTRACE-REF-001', amount: 999 },
        });
        await injKnex('DuhGoodsImportRecord').insert({
          name: 'first-race-winner-v1',
          created: now,
          modified: now,
          createdBy: '__SYSTEM__',
          modifiedBy: '__SYSTEM__',
          importSource: meta.importSourceId,
          sourceType: txn.sourceType,
          sourceNamespace: meta.sourceNamespace,
          sourceId: 'FIRSTRACE-WINNER',
          identityKey: meta.identityKey,
          rowLocator: 0,
          transactionType: txn.transactionType,
          transactionDate: now,
          currency: txn.currency,
          grossAmount: '999.00',
          fees: '0.00',
          taxes: '0.00',
          netAmount: '999.00',
          status: 'pending',
          rawData: JSON.stringify({ ref: 'FIRSTRACE-REF-001', amount: 999 }),
          evidenceHash: winnerEvidenceHash,
          evidenceVersion: 1,
          priorEvidenceHash: '',
          notes: null,
        });
      }
      return super._insertRecord(txn, meta);
    }
  }

  function makeTxnAdapter(txns: ImportedTransaction[]) {
    return { sourceType: 'bank_statement' as const, parse: () => txns };
  }

  const txn: ImportedTransaction = {
    sourceId: 'FIRSTRACE-REF-001',
    sourceType: 'bank_statement',
    transactionType: 'bank_credit',
    transactionDate: new Date('2024-03-01'),
    currency: 'SAR',
    grossAmount: '500.00',
    fees: '0.00',
    taxes: '0.00',
    netAmount: '500.00',
    rawData: { ref: 'FIRSTRACE-REF-001', amount: 500 },
  };

  const r = await new RaceFirstInsertOrchestrator(
    fyo,
    makeTxnAdapter([txn])
  ).import(Buffer.from(''), {
    sourceName: 'First Race Import',
    sourceNamespace: ns,
    sourceFile: 'firstrace.csv',
  });

  t.ok(raceInjected, 'first-insert race injection was triggered');
  t.equal(
    r.exceptions,
    1,
    'result: 1 exception (our evidence appended as version 2)'
  );
  t.equal(r.errors.length, 0, 'result: no errors (race resolved)');
  t.equal(r.imported, 0, 'result: 0 imported (our first-insert was displaced)');

  const identityKey = computeIdentityKey({
    sourceType: 'bank_statement',
    sourceNamespace: ns,
    externalSourceId: 'FIRSTRACE-REF-001',
  });
  const allVersions = await fyo.db.getAll('DuhGoodsImportRecord', {
    filters: { identityKey },
    fields: [
      'name',
      'evidenceVersion',
      'evidenceHash',
      'status',
      'priorEvidenceHash',
    ],
    orderBy: 'evidenceVersion',
    order: 'asc',
  });

  t.equal(
    allVersions.length,
    2,
    'exactly 2 evidence records — neither evidence lost'
  );
  t.equal(
    Number(allVersions[0].evidenceVersion),
    1,
    'version 1 exists (winner)'
  );
  t.equal(
    Number(allVersions[1].evidenceVersion),
    2,
    'version 2 exists (our evidence as exception)'
  );
  t.equal(allVersions[1].status, 'exception', 'version 2 status=exception');
  t.equal(
    allVersions[1].priorEvidenceHash,
    allVersions[0].evidenceHash,
    'version 2 priorEvidenceHash links to version 1'
  );
  t.notEqual(
    allVersions[0].evidenceHash,
    allVersions[1].evidenceHash,
    'both versions have distinct evidenceHash — different evidence preserved'
  );

  await fyo.close();
  await injectorDm.db!.close();
  for (const f of [
    raceTempPath,
    `${raceTempPath}-wal`,
    `${raceTempPath}-shm`,
  ]) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
  t.end();
});
