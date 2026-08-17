import test from 'tape';
import { pesa } from 'pesa';
import {
  evaluateReconciliation,
  generateReconciliationProposals,
} from '../duhgoods/reconciliation/ReconciliationEngine';
import type { ReconciliationRecord } from '../duhgoods/reconciliation/ReconciliationEngine';

function record(
  overrides: Partial<ReconciliationRecord>
): ReconciliationRecord {
  return {
    name: 'record',
    sourceType: 'woocommerce',
    transactionType: 'order',
    transactionDate: new Date('2026-08-01T00:00:00.000Z'),
    currency: 'SAR',
    grossAmount: pesa('100.00'),
    netAmount: pesa('100.00'),
    status: 'imported',
    evidenceVersion: 1,
    ...overrides,
  };
}

test('reconciliation: creates canonical exact proposal with aligned evidence', (t) => {
  const proposals = generateReconciliationProposals(
    [
      record({
        name: 'payment-1',
        sourceType: 'psp_export',
        transactionType: 'payment',
        evidenceHash: 'payment-hash',
        rawData: JSON.stringify({ orderId: 'W-1' }),
      }),
      record({
        name: 'order-1',
        evidenceHash: 'order-hash',
        rawData: JSON.stringify({ orderId: 'W-1' }),
      }),
    ],
    pesa
  );

  t.equal(proposals.length, 1, 'one eligible proposal');
  const proposal = proposals[0];
  t.equal(proposal.edgeKey, 'order-1:payment-1', 'edge key is deterministic');
  t.equal(
    proposal.leftRecord,
    'order-1',
    'left record follows canonical order'
  );
  t.equal(
    proposal.leftEvidenceHash,
    'order-hash',
    'left evidence follows left record'
  );
  t.equal(
    proposal.rightEvidenceHash,
    'payment-hash',
    'right evidence follows right record'
  );
  t.equal(
    proposal.confidence,
    'exact',
    'shared reference produces exact confidence'
  );
  t.end();
});

test('reconciliation: excludes stale evidence and ineligible pairs', (t) => {
  const proposals = generateReconciliationProposals(
    [
      record({
        name: 'order-current',
        identityKey: 'woocommerce:W-1',
        evidenceVersion: 2,
      }),
      record({
        name: 'order-stale',
        identityKey: 'woocommerce:W-1',
        evidenceVersion: 1,
      }),
      record({
        name: 'payment-wrong-source',
        sourceType: 'woocommerce',
        transactionType: 'payment',
      }),
    ],
    pesa
  );

  t.equal(
    proposals.length,
    0,
    'only latest, source-compatible evidence can match'
  );
  t.end();
});

test('reconciliation: excludes an identity whose newest evidence is exception', (t) => {
  const proposals = generateReconciliationProposals(
    [
      record({
        name: 'order-v1',
        identityKey: 'woocommerce:W-1',
        evidenceVersion: 1,
      }),
      record({
        name: 'order-v2-exception',
        identityKey: 'woocommerce:W-1',
        evidenceVersion: 2,
        status: 'exception',
      }),
      record({
        name: 'payment-1',
        sourceType: 'psp_export',
        transactionType: 'payment',
      }),
    ],
    pesa
  );

  t.equal(
    proposals.length,
    0,
    'the exception version suppresses the whole evidence identity'
  );
  t.end();
});

test('reconciliation: high confidence requires a unique close-date candidate', (t) => {
  const proposals = generateReconciliationProposals(
    [
      record({ name: 'order-1' }),
      record({
        name: 'payment-1',
        sourceType: 'psp_export',
        transactionType: 'payment',
        transactionDate: new Date('2026-08-02T00:00:00.000Z'),
      }),
    ],
    pesa
  );

  t.equal(
    proposals[0].confidence,
    'high',
    'one close compatible candidate is high'
  );
  t.notOk(
    proposals[0].reasonCodes.includes('explicit_reference'),
    'no source reference was invented'
  );
  t.end();
});

test('reconciliation: ambiguous close-date candidates remain proposed at medium confidence', (t) => {
  const proposals = generateReconciliationProposals(
    [
      record({ name: 'order-1' }),
      record({
        name: 'payment-1',
        sourceType: 'psp_export',
        transactionType: 'payment',
        transactionDate: new Date('2026-08-02T00:00:00.000Z'),
      }),
      record({
        name: 'payment-2',
        sourceType: 'psp_export',
        transactionType: 'payment',
        transactionDate: new Date('2026-08-02T00:00:00.000Z'),
      }),
    ],
    pesa
  );

  t.equal(proposals.length, 2, 'all legitimate candidates are retained');
  t.ok(
    proposals.every((proposal) => proposal.confidence === 'medium'),
    'ambiguous candidates are not high confidence'
  );
  t.ok(
    proposals.every((proposal) =>
      proposal.reasonCodes.includes('ambiguous_candidates')
    ),
    'ambiguity is auditable'
  );
  t.end();
});

test('reconciliation: reports compatible cross-currency records for future FX', (t) => {
  const evaluation = evaluateReconciliation(
    [
      record({ name: 'order-1', currency: 'SAR' }),
      record({
        name: 'payment-1',
        sourceType: 'psp_export',
        transactionType: 'payment',
        currency: 'USD',
      }),
    ],
    pesa
  );

  t.equal(
    evaluation.proposals.length,
    0,
    'cross-currency records are not matched'
  );
  t.deepEqual(
    evaluation.outcomes,
    [
      {
        leftRecord: 'order-1',
        rightRecord: 'payment-1',
        outcome: 'requires_future_fx',
        reasonCodes: [
          'compatible_transaction_types',
          'different_currency_requires_fx',
        ],
      },
    ],
    'future FX outcome is explicit'
  );
  t.end();
});

test('reconciliation: enforces refund, settlement, and chargeback amount directions', (t) => {
  const proposals = generateReconciliationProposals(
    [
      record({
        name: 'woo-refund',
        transactionType: 'refund',
        grossAmount: pesa('-19.99'),
        netAmount: pesa('-19.99'),
      }),
      record({
        name: 'psp-refund',
        sourceType: 'psp_export',
        transactionType: 'refund',
        grossAmount: pesa('-19.99'),
        netAmount: pesa('-19.99'),
      }),
      record({
        name: 'settlement',
        sourceType: 'psp_export',
        transactionType: 'settlement',
        grossAmount: pesa('70'),
        netAmount: pesa('70'),
      }),
      record({
        name: 'bank-credit',
        sourceType: 'bank_statement',
        transactionType: 'bank_credit',
        grossAmount: pesa('70'),
        netAmount: pesa('70'),
      }),
      record({
        name: 'chargeback',
        sourceType: 'psp_export',
        transactionType: 'chargeback',
        grossAmount: pesa('-12'),
        netAmount: pesa('-12'),
      }),
      record({
        name: 'bank-debit',
        sourceType: 'bank_statement',
        transactionType: 'bank_debit',
        grossAmount: pesa('12'),
        netAmount: pesa('-12'),
      }),
    ],
    pesa
  );

  t.deepEqual(
    proposals.map((proposal) => proposal.edgeKey),
    [
      'bank-credit:settlement',
      'bank-debit:chargeback',
      'psp-refund:woo-refund',
    ],
    'each relationship uses its documented economic direction'
  );
  t.end();
});

test('reconciliation: matches PSP refund and chargeback by economic magnitude', (t) => {
  const proposals = generateReconciliationProposals(
    [
      record({
        name: 'woo-refund',
        transactionType: 'refund',
        grossAmount: pesa('-19.99'),
        netAmount: pesa('-19.99'),
      }),
      record({
        name: 'psp-refund-positive',
        sourceType: 'psp_export',
        transactionType: 'refund',
        grossAmount: pesa('19.99'),
        netAmount: pesa('19.99'),
      }),
      record({
        name: 'psp-chargeback-positive',
        sourceType: 'psp_export',
        transactionType: 'chargeback',
        grossAmount: pesa('12'),
        netAmount: pesa('12'),
      }),
      record({
        name: 'bank-debit',
        sourceType: 'bank_statement',
        transactionType: 'bank_debit',
        grossAmount: pesa('12'),
        netAmount: pesa('-12'),
      }),
    ],
    pesa
  );

  t.deepEqual(
    proposals.map((proposal) => proposal.edgeKey),
    ['bank-debit:psp-chargeback-positive', 'psp-refund-positive:woo-refund'],
    'positive PSP source signs reconcile using their economic magnitudes'
  );
  t.ok(
    proposals.every((proposal) => proposal.amountDelta.isZero()),
    'magnitude comparison preserves an exact Money delta'
  );
  t.end();
});

test('reconciliation: rejects incompatible, out-of-window, mismatched, self, and invalid-direction candidates', (t) => {
  const proposals = generateReconciliationProposals(
    [
      record({ name: 'order-1' }),
      record({
        name: 'payment-1',
        sourceType: 'psp_export',
        transactionType: 'payment',
        grossAmount: pesa('99.99'),
      }),
      record({
        name: 'payment-2',
        sourceType: 'psp_export',
        transactionType: 'payment',
        transactionDate: new Date('2026-08-10T00:00:00.000Z'),
      }),
      record({
        name: 'refund-1',
        transactionType: 'refund',
        grossAmount: pesa('100'),
        netAmount: pesa('100'),
      }),
      record({
        name: 'refund-2',
        sourceType: 'psp_export',
        transactionType: 'refund',
        grossAmount: pesa('100'),
        netAmount: pesa('100'),
      }),
    ],
    pesa
  );

  t.equal(
    proposals.length,
    0,
    'only type-compatible, same-direction, exact, in-window pairs produce candidates'
  );
  t.end();
});

test('reconciliation: never proposes a record as its own match', (t) => {
  const proposals = generateReconciliationProposals(
    [
      record({
        name: 'same-record',
        sourceType: 'woocommerce',
        transactionType: 'order',
      }),
    ],
    pesa
  );

  t.equal(proposals.length, 0, 'a single record cannot be paired with itself');
  t.end();
});

test('reconciliation: compares fractional and large decimal evidence through Pesa', (t) => {
  const amount = '9007199254740993.123456789';
  const proposals = generateReconciliationProposals(
    [
      record({ name: 'order-1', grossAmount: pesa(amount) }),
      record({
        name: 'payment-1',
        sourceType: 'psp_export',
        transactionType: 'payment',
        grossAmount: pesa(amount),
      }),
    ],
    pesa
  );

  t.equal(proposals.length, 1, 'large fractional amount matches exactly');
  t.ok(proposals[0].amountDelta.isZero(), 'delta uses exact Money arithmetic');
  t.end();
});
