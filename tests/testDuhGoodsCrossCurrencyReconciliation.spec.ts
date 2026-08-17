/**
 * Cross-currency reconciliation acceptance tests.
 *
 * Governing rule: every currency is reconciled only against itself. There is
 * no cross-currency matching path, no FX conversion, and no "identity via
 * shared reference" mechanism — even when two records plainly represent the
 * same economic event (e.g. a WooCommerce USD order and its PSP SAR
 * payment), they are never linked by the reconciliation engine.
 *
 * Hard assertions:
 *   1. USD Woo order + SAR PSP payment sharing an order_id reference are
 *      NOT linked, despite the reference — no proposal is created for them.
 *   2. The engine never produces a proposal carrying any cross-currency
 *      reason code.
 *   3. Both source records keep their original, untouched amounts.
 *   4. The USD and SAR records both remain unmatched (no accepted/proposed
 *      match involves either of them together).
 *   5. Same-currency legs (SAR settlement ↔ SAR bank credit) still
 *      reconcile normally — the same-currency rule is unaffected.
 *   6. No FX rate or converted amount is ever attached to the USD record.
 */

import test from 'tape';
import type { Money } from 'pesa';
import { ModelNameEnum } from 'models/types';
import { DailyOrchestrator } from '../duhgoods/daily/DailyOrchestrator';
import { DuhGoodsReconciliationService } from '../duhgoods/reconciliation/ReconciliationService';
import { closeTestFyo, getTestFyo, setupTestFyo } from './helpers';
import { evaluateReconciliation } from '../duhgoods/reconciliation/ReconciliationEngine';
import type { ReconciliationRecord } from '../duhgoods/reconciliation/ReconciliationEngine';

const fyo = getTestFyo();
setupTestFyo(fyo, __filename);

// ─── Fixtures ────────────────────────────────────────────────────────────────

// WooCommerce: 100 USD order with id 'WOO-CC-001'
const WOO_CC_FIXTURE = JSON.stringify([
  {
    id: 'WOO-CC-001',
    date_created: '2026-09-01T10:00:00',
    currency: 'USD',
    total: '100.00',
    total_tax: '0.00',
    shipping_total: '0.00',
    discount_total: '0.00',
    total_shipping_tax: '0.00',
    payment_method: 'stripe',
    status: 'completed',
    refunds: [],
  },
]);

// PSP: SAR payment referencing WOO-CC-001 via order_id, plus a settlement payout
const PSP_CC_FIXTURE = JSON.stringify([
  {
    id: 'psp-cc-capture-001',
    type: 'payment',
    date: '2026-09-01',
    currency: 'SAR',
    gross: '374.00',
    fee: '8.00',
    tax: '0',
    net: '366.00',
    order_id: 'WOO-CC-001', // shared reference — must NOT create a match
  },
  {
    id: 'psp-cc-settle-001',
    type: 'payout',
    date: '2026-09-05',
    currency: 'SAR',
    gross: '366.00',
    fee: '0',
    tax: '0',
    net: '366.00',
  },
]);

// Bank: SAR credit matching settlement
const BANK_CC_FIXTURE = JSON.stringify([
  {
    date: '2026-09-07',
    description: 'Settlement',
    credit: '366.00',
    debit: '',
  },
]);

// ─── Test 1: Shared reference does NOT link cross-currency records ───────────

test('CC-1: WooCommerce USD order and PSP SAR payment are NOT linked despite shared order_id', async (t) => {
  const orchestrator = new DailyOrchestrator(fyo);
  const summary = await orchestrator.runDailyImport({
    woocommerce: { content: WOO_CC_FIXTURE, namespace: 'cc-woo' },
    psp: { content: PSP_CC_FIXTURE, namespace: 'cc-psp', currency: 'SAR' },
    bank: { content: BANK_CC_FIXTURE, namespace: 'cc-bank', currency: 'SAR' },
  });

  t.equal(summary.errors, 0, `zero import errors (got: ${summary.errors})`);
  t.equal(summary.imported, 4, `4 records imported (got ${summary.imported})`);

  const matches = await fyo.db.getAll(
    ModelNameEnum.DuhGoodsReconciliationMatch,
    {
      fields: ['name', 'status', 'confidence', 'leftRecord', 'rightRecord'],
    }
  );

  const usdRecord = (
    await fyo.db.getAll(ModelNameEnum.DuhGoodsImportRecord, {
      filters: { currency: 'USD' },
      fields: ['name'],
    })
  )[0];
  const pspPayment = (
    await fyo.db.getAll(ModelNameEnum.DuhGoodsImportRecord, {
      filters: { currency: 'SAR', transactionType: 'payment' },
      fields: ['name'],
    })
  )[0];

  const crossMatch = matches.find(
    (m) =>
      (m.leftRecord === usdRecord.name && m.rightRecord === pspPayment.name) ||
      (m.leftRecord === pspPayment.name && m.rightRecord === usdRecord.name)
  );

  t.notOk(
    crossMatch,
    'no reconciliation match exists between the USD order and the SAR payment, despite the shared order_id reference'
  );

  t.end();
});

// ─── Test 2: Woo USD source amount unchanged after import ────────────────────

test('CC-2: WooCommerce USD source amount remains exactly 100 USD', async (t) => {
  const usdRecords = await fyo.db.getAll(ModelNameEnum.DuhGoodsImportRecord, {
    filters: { currency: 'USD' },
    fields: ['name', 'currency', 'grossAmount', 'netAmount', 'rawData', 'status'],
  });

  t.equal(usdRecords.length, 1, 'exactly one USD record in DB');

  const r = usdRecords[0];
  t.equal(String(r.currency), 'USD', 'currency field is USD');

  const gross = fyo.pesa(String(r.grossAmount ?? 0)).float;
  t.ok(
    Math.abs(gross - 100.0) < 0.005,
    `grossAmount is exactly 100 USD (got ${gross})`
  );

  // Never matched, so it must remain in its unmatched/pending state.
  t.notEqual(
    String(r.status),
    'reconciled',
    'USD order was never reconciled against the SAR payment'
  );

  // Verify raw source data still contains the USD value — not overwritten
  let rawParsed: Record<string, unknown> = {};
  try {
    rawParsed = JSON.parse(String(r.rawData ?? '{}')) as Record<
      string,
      unknown
    >;
  } catch {
    // ignore
  }
  t.equal(
    String(rawParsed.currency ?? ''),
    'USD',
    'rawData.currency is still USD'
  );
  t.equal(
    String(rawParsed.total ?? ''),
    '100.00',
    'rawData.total is still 100.00'
  );

  t.end();
});

// ─── Test 3: PSP SAR source facts unchanged after import ─────────────────────

test('CC-3: PSP SAR source facts (amount, fee, net) remain unchanged', async (t) => {
  const pspPayment = await fyo.db.getAll(ModelNameEnum.DuhGoodsImportRecord, {
    filters: { currency: 'SAR', transactionType: 'payment' },
    fields: ['name', 'currency', 'grossAmount', 'netAmount', 'rawData'],
  });

  const pspRecord = pspPayment.find(
    (r) => Math.abs(fyo.pesa(String(r.grossAmount ?? 0)).float - 374.0) < 0.005
  );

  t.ok(pspRecord, 'PSP payment record with gross=374 SAR found');

  if (pspRecord) {
    t.equal(String(pspRecord.currency), 'SAR', 'PSP currency is SAR');
    const gross = fyo.pesa(String(pspRecord.grossAmount ?? 0)).float;
    t.ok(
      Math.abs(gross - 374.0) < 0.005,
      `PSP gross is 374.00 SAR (got ${gross})`
    );

    const net = fyo.pesa(String(pspRecord.netAmount ?? 0)).float;
    t.ok(Math.abs(net - 366.0) < 0.005, `PSP net is 366.00 SAR (got ${net})`);

    let rawParsed: Record<string, unknown> = {};
    try {
      rawParsed = JSON.parse(String(pspRecord.rawData ?? '{}')) as Record<
        string,
        unknown
      >;
    } catch {
      // ignore
    }
    t.equal(
      String(rawParsed.gross ?? ''),
      '374.00',
      'rawData.gross is still 374.00'
    );
    t.equal(
      String(rawParsed.fee ?? ''),
      '8.00',
      'rawData.fee is still 8.00 (not rewritten)'
    );
    t.equal(
      String(rawParsed.net ?? ''),
      '366.00',
      'rawData.net is still 366.00'
    );
    t.equal(
      String(rawParsed.order_id ?? ''),
      'WOO-CC-001',
      'rawData.order_id preserved as WOO-CC-001 (reference kept, but never used to match)'
    );
  }

  t.end();
});

// ─── Test 4: No FX rate or converted amount is ever attached ─────────────────

test('CC-4: USD record never receives an FX rate or a converted amount', async (t) => {
  const usdRecords = await fyo.db.getAll(ModelNameEnum.DuhGoodsImportRecord, {
    filters: { currency: 'USD' },
    fields: ['name', 'fxRate', 'functionalCurrencyAmount', 'fxReviewNote'],
  });

  t.ok(usdRecords.length > 0, 'USD record exists');
  const r = usdRecords[0];

  t.notOk(r.fxRate, 'no fxRate is ever set on the USD record');
  // functionalCurrencyAmount is a Currency field — the DB layer returns a
  // zero Money instance (never undefined) when it was never written to.
  const functionalAmount = r.functionalCurrencyAmount as Money | undefined;
  t.ok(
    !functionalAmount || functionalAmount.isZero(),
    'no functionalCurrencyAmount is ever set on the USD record'
  );

  t.end();
});

// ─── Test 5: No forbidden 3.75 rate assumption anywhere ──────────────────────

test('CC-5: No FX rate or conversion artifact appears anywhere in reconciliation output', async (t) => {
  const matches = await fyo.db.getAll(
    ModelNameEnum.DuhGoodsReconciliationMatch,
    {
      fields: ['name', 'evidenceSnapshot', 'reasonCodes'],
    }
  );

  const violators = matches.filter((m) =>
    String(m.reasonCodes ?? '').includes('cross_currency')
  );
  t.equal(
    violators.length,
    0,
    `no reconciliation match carries a cross-currency reason code (violators: ${violators
      .map((m) => m.name)
      .join(', ')})`
  );

  const fxRates = await fyo.db
    .getAll(ModelNameEnum.DuhGoodsFXRate, { fields: ['name', 'rate'] })
    .catch(() => [] as Record<string, unknown>[]);
  t.equal(
    fxRates.length,
    0,
    'no FX rate evidence was created — nothing in this flow ever calls FXService'
  );

  t.end();
});

// ─── Test 6: Missing reference — same behaviour as a shared reference ────────

test('CC-6: Cross-currency pair produces no proposal whether or not a reference exists', async (t) => {
  const noRefRecords: ReconciliationRecord[] = [
    {
      name: 'woo-no-ref-001',
      sourceType: 'woocommerce',
      transactionType: 'order',
      transactionDate: new Date('2026-09-01'),
      currency: 'USD',
      grossAmount: fyo.pesa('100.00'),
      netAmount: fyo.pesa('100.00'),
      status: 'pending',
      rawData: JSON.stringify({
        id: 'NO-REF',
        total: '100.00',
        currency: 'USD',
      }),
    },
    {
      name: 'psp-no-ref-001',
      sourceType: 'psp_export',
      transactionType: 'payment',
      transactionDate: new Date('2026-09-01'),
      currency: 'SAR',
      grossAmount: fyo.pesa('374.00'),
      netAmount: fyo.pesa('366.00'),
      status: 'pending',
      rawData: JSON.stringify({
        id: 'PSP-NOREF',
        gross: '374.00',
        currency: 'SAR',
      }),
    },
  ];

  const result = evaluateReconciliation(noRefRecords, (v) =>
    fyo.pesa(String(v))
  );

  t.equal(
    result.proposals.length,
    0,
    'no proposal is created for a cross-currency pair, reference or not'
  );

  // The pair is still surfaced as a "different currency, unmatched" outcome
  // for visibility — but it carries no FX/conversion implication.
  const outcomes = result.outcomes.filter(
    (o) => o.outcome === 'different_currency_unmatched'
  );
  t.ok(
    outcomes.length > 0,
    'the pair is reported as different_currency_unmatched'
  );

  t.end();
});

// ─── Test 7: WooCommerce USD order + a same-reference SAR order do match ─────

test('CC-7: A shared reference between records of the SAME currency still matches normally', async (t) => {
  const sameCurrencyRecords: ReconciliationRecord[] = [
    {
      name: 'woo-same-001',
      sourceType: 'woocommerce',
      transactionType: 'order',
      transactionDate: new Date('2026-09-01'),
      currency: 'SAR',
      grossAmount: fyo.pesa('374.00'),
      netAmount: fyo.pesa('374.00'),
      status: 'pending',
      rawData: JSON.stringify({ id: 'SAME-CCY-1', total: '374.00' }),
    },
    {
      name: 'psp-same-001',
      sourceType: 'psp_export',
      transactionType: 'payment',
      transactionDate: new Date('2026-09-01'),
      currency: 'SAR',
      grossAmount: fyo.pesa('374.00'),
      netAmount: fyo.pesa('374.00'),
      status: 'pending',
      rawData: JSON.stringify({ id: 'PSP-SAME-1', order_id: 'SAME-CCY-1' }),
    },
  ];

  const result = evaluateReconciliation(sameCurrencyRecords, (v) =>
    fyo.pesa(String(v))
  );

  t.equal(
    result.proposals.length,
    1,
    'same-currency records with matching amounts still produce a proposal'
  );
  t.equal(result.outcomes.length, 0, 'no unmatched-currency outcome for a same-currency pair');

  t.end();
});

// ─── Test 8: Same-currency chain (PSP settlement ↔ Bank) still reconciles ────

test('CC-8: SAR settlement ↔ SAR bank credit chain reconciles normally', async (t) => {
  const svc = new DuhGoodsReconciliationService(fyo);

  const proposed = await fyo.db.getAll(
    ModelNameEnum.DuhGoodsReconciliationMatch,
    {
      filters: { status: 'proposed' },
      fields: ['name'],
    }
  );

  for (const m of proposed) {
    await svc.accept(m.name as string, 'cc-test').catch(() => {
      /* already accepted or conflict */
    });
  }

  const accepted = await fyo.db.getAll(
    ModelNameEnum.DuhGoodsReconciliationMatch,
    {
      filters: { status: 'accepted' },
      fields: ['name', 'leftRecord', 'rightRecord'],
    }
  );

  t.ok(accepted.length > 0, 'at least one accepted match (the SAR chain)');

  // Every accepted match must be between two SAR records — no cross-currency
  // acceptance is ever possible.
  const recordCurrencies = new Map<string, string>();
  for (const r of await fyo.db.getAll(ModelNameEnum.DuhGoodsImportRecord, {
    fields: ['name', 'currency'],
  })) {
    recordCurrencies.set(String(r.name), String(r.currency ?? ''));
  }

  const mixedCurrencyMatches = accepted.filter((m) => {
    const leftCcy = recordCurrencies.get(String(m.leftRecord));
    const rightCcy = recordCurrencies.get(String(m.rightRecord));
    return leftCcy && rightCcy && leftCcy !== rightCcy;
  });
  t.equal(
    mixedCurrencyMatches.length,
    0,
    'no accepted match spans two different currencies'
  );

  // The USD order remains outside every accepted match.
  const usdRecord = (
    await fyo.db.getAll(ModelNameEnum.DuhGoodsImportRecord, {
      filters: { currency: 'USD' },
      fields: ['name'],
    })
  )[0];
  const usdInvolved = accepted.some(
    (m) => m.leftRecord === usdRecord.name || m.rightRecord === usdRecord.name
  );
  t.notOk(usdInvolved, 'the USD order is not part of any accepted match');

  t.end();
});

closeTestFyo(fyo, __filename);
