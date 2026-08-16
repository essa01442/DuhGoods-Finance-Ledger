import test from 'tape';
import { BankStatementImporter } from '../duhgoods/importers/BankStatementImporter';
import { PSPExportImporter } from '../duhgoods/importers/PSPExportImporter';
import { WooCommerceImporter } from '../duhgoods/importers/WooCommerceImporter';
import { ImportValidationError } from '../duhgoods/importers/types';
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
  t.equal(
    h1,
    h2,
    'reference-less row produces idempotent evidence hash via rawData'
  );
  t.end();
});
