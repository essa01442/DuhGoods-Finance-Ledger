import test from 'tape';
import { pesa } from 'pesa';
import {
  generateReconciliationProposals,
  type ReconciliationRecord,
} from '../duhgoods/reconciliation/ReconciliationEngine';

function record(overrides: Partial<ReconciliationRecord>): ReconciliationRecord {
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
  const proposals = generateReconciliationProposals([
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
  ], pesa);

  t.equal(proposals.length, 1, 'one eligible proposal');
  const proposal = proposals[0];
  t.equal(proposal.edgeKey, 'order-1:payment-1', 'edge key is deterministic');
  t.equal(proposal.leftRecord, 'order-1', 'left record follows canonical order');
  t.equal(proposal.leftEvidenceHash, 'order-hash', 'left evidence follows left record');
  t.equal(proposal.rightEvidenceHash, 'payment-hash', 'right evidence follows right record');
  t.equal(proposal.confidence, 'exact', 'shared reference produces exact confidence');
  t.end();
});

test('reconciliation: excludes stale evidence and ineligible pairs', (t) => {
  const proposals = generateReconciliationProposals([
    record({ name: 'order-current', identityKey: 'woocommerce:W-1', evidenceVersion: 2 }),
    record({ name: 'order-stale', identityKey: 'woocommerce:W-1', evidenceVersion: 1 }),
    record({
      name: 'payment-wrong-source',
      sourceType: 'woocommerce',
      transactionType: 'payment',
    }),
  ], pesa);

  t.equal(proposals.length, 0, 'only latest, source-compatible evidence can match');
  t.end();
});
