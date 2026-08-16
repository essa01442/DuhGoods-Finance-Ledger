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

test('computeFileHash: hashes raw bytes; computeEvidenceHash hashes normalised object — same bytes, different semantics', (t) => {
  // These two functions serve different purposes:
  // computeFileHash  → SHA-256 of exact source-file bytes (provenance of the import file)
  // computeEvidenceHash → SHA-256 of key-sorted canonical JSON of a normalised object
  // We verify each is deterministic and that the same multi-record content
  // produces a file hash that differs from the per-record evidence hash.
  const sourceContent = JSON.stringify(wooOrdersValid); // multi-record file
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
  },
];

test('WooCommerceImporter: parses completed and refunded orders', (t) => {
  const importer = new WooCommerceImporter();
  const txns = importer.parse(JSON.stringify(wooOrdersValid));

  t.equal(txns.length, 2, 'two transactions');
  t.equal(txns[0].sourceId, '101', 'sourceId from order id');
  t.equal(txns[0].sourceType, 'woocommerce', 'correct source type');
  t.equal(txns[0].transactionType, 'order', 'completed → order');
  t.equal(txns[1].transactionType, 'refund', 'refunded → refund');
  t.equal(txns[0].currency, 'SAR', 'currency preserved');
  t.equal(txns[0].grossAmount, 500, 'gross amount');
  t.equal(txns[0].taxes, 65, 'tax amount');
  t.equal(txns[0].fees, 0, 'fees = 0 (PSP fees are not WooCommerce fields)');
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

test('WooCommerceImporter: rawData preserves shipping and discount separately', (t) => {
  const importer = new WooCommerceImporter();
  const txns = importer.parse(JSON.stringify(wooOrdersValid));
  t.equal(
    txns[0].rawData._woo_shipping_total,
    20,
    'shipping preserved in rawData'
  );
  t.equal(
    txns[0].rawData._woo_discount_total,
    10,
    'discount preserved in rawData'
  );
  t.equal(
    txns[0].fees,
    0,
    'fees field is NOT populated from WooCommerce fields'
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

test('PSPExportImporter: parses valid rows', (t) => {
  const importer = new PSPExportImporter();
  const txns = importer.parse(JSON.stringify(pspRowsValid));

  t.equal(txns.length, 3, 'three rows');
  t.equal(txns[0].transactionType, 'payment', 'payment type');
  t.equal(txns[1].transactionType, 'refund', 'refund type');
  t.equal(txns[2].transactionType, 'chargeback', 'chargeback type');
  t.equal(txns[0].sourceId, 'TXN-001', 'sourceId from id field');
  t.equal(txns[0].fees, 9, 'fee captured');
  t.equal(txns[0].netAmount, 289.65, 'net amount');
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

// ── PSPExportImporter — rejection cases ─────────────────────────────────────

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
    'throws ImportValidationError for unknown PSP type — never silently becomes payment'
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
  // Real JSON payloads cannot contain JS Infinity; a string "Infinity" is the
  // realistic representation that Number("Infinity") = Infinity (non-finite).
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
    'throws for string "Infinity" fee (Number("Infinity") is not finite)'
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

test('BankStatementImporter: parses credit and debit rows', (t) => {
  const importer = new BankStatementImporter('SAR');
  const txns = importer.parse(JSON.stringify(bankRowsValid));

  t.equal(txns.length, 2, 'two rows');
  t.equal(txns[0].transactionType, 'bank_credit', 'credit row');
  t.equal(txns[1].transactionType, 'bank_debit', 'debit row');
  t.equal(txns[0].grossAmount, 1500, 'credit amount');
  t.equal(txns[1].grossAmount, 800, 'debit amount (magnitude)');
  t.equal(txns[0].netAmount, 1500, 'credit net positive');
  t.equal(txns[1].netAmount, -800, 'debit net negative');
  t.equal(txns[0].sourceId, 'REF001', 'reference used as sourceId');
  t.end();
});

test('BankStatementImporter: uses default SAR currency', (t) => {
  const importer = new BankStatementImporter();
  const txns = importer.parse(JSON.stringify(bankRowsValid));
  t.equal(txns[0].currency, 'SAR', 'defaults to SAR');
  t.end();
});

test('BankStatementImporter: row without reference uses internal-seq prefix', (t) => {
  const importer = new BankStatementImporter('SAR');
  const rows = [{ date: '2024-01-01', credit: '100.00', debit: '' }];
  const txns = importer.parse(JSON.stringify(rows));
  t.ok(
    txns[0].sourceId.startsWith('internal-seq-'),
    'generated sourceId has internal-seq prefix'
  );
  t.equal(
    txns[0].rawData._hasSourceRef,
    false,
    'rawData records absence of source reference'
  );
  t.end();
});

test('BankStatementImporter: rejects non-array input', (t) => {
  const importer = new BankStatementImporter();
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

test('BankStatementImporter: zero-value row (both zero) throws ImportValidationError', (t) => {
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

// ── Source-file hash vs evidence hash distinction ────────────────────────────

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
