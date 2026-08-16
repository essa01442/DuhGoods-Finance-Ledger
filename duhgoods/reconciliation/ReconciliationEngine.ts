import type { Money } from 'pesa';

export type ReconciliationConfidence = 'exact' | 'high' | 'medium' | 'low';
export type ReconciliationReason =
  | 'compatible_transaction_types'
  | 'same_currency'
  | 'exact_amount'
  | 'amount_mismatch'
  | 'date_within_window'
  | 'date_outside_window'
  | 'explicit_reference'
  | 'different_currency_requires_fx'
  | 'stale_evidence'
  | 'self_match';

export interface ReconciliationRecord {
  name: string;
  sourceType?: string;
  sourceId?: string;
  transactionType?: string;
  transactionDate?: Date;
  currency?: string;
  grossAmount?: Money;
  netAmount?: Money;
  status?: string;
  identityKey?: string;
  evidenceHash?: string;
  evidenceVersion?: number;
  rawData?: string;
}

export interface ReconciliationProposal {
  leftRecord: string;
  rightRecord: string;
  matchType: 'imported_evidence';
  confidence: ReconciliationConfidence;
  reasonCodes: ReconciliationReason[];
  amountDelta: Money;
  dateDeltaDays: number;
  edgeKey: string;
  leftEvidenceHash: string;
  rightEvidenceHash: string;
  evidenceSnapshot: string;
}

export const RECONCILIATION_WINDOWS_DAYS = {
  orderPayment: 3,
  refundRefund: 3,
  settlementBankCredit: 7,
  chargebackBankDebit: 14,
} as const;

const RELATIONSHIPS: Record<
  string,
  { left: string; right: string; days: number; leftAmount: 'gross' | 'net'; rightAmount: 'gross' | 'net' }
> = {
  order_payment: {
    left: 'order',
    right: 'payment',
    days: RECONCILIATION_WINDOWS_DAYS.orderPayment,
    leftAmount: 'gross',
    rightAmount: 'gross',
  },
  refund_refund: {
    left: 'refund',
    right: 'refund',
    days: RECONCILIATION_WINDOWS_DAYS.refundRefund,
    leftAmount: 'net',
    rightAmount: 'net',
  },
  settlement_bank_credit: {
    left: 'settlement',
    right: 'bank_credit',
    days: RECONCILIATION_WINDOWS_DAYS.settlementBankCredit,
    leftAmount: 'net',
    rightAmount: 'net',
  },
  chargeback_bank_debit: {
    left: 'chargeback',
    right: 'bank_debit',
    days: RECONCILIATION_WINDOWS_DAYS.chargebackBankDebit,
    leftAmount: 'net',
    rightAmount: 'net',
  },
};

export function generateReconciliationProposals(
  records: ReconciliationRecord[],
  pesa: (value: string | number) => Money
): ReconciliationProposal[] {
  const latest = latestValidEvidence(records);
  const proposals: ReconciliationProposal[] = [];

  for (const left of latest) {
    for (const right of latest) {
      if (left.name >= right.name) continue;
      const relationship = findRelationship(left.transactionType, right.transactionType);
      if (!relationship) continue;
      const ordered = relationship.left === left.transactionType ? [left, right] : [right, left];
      const proposal = scorePair(ordered[0], ordered[1], relationship, pesa);
      if (proposal) proposals.push(proposal);
    }
  }

  return proposals.sort((a, b) => a.edgeKey.localeCompare(b.edgeKey));
}

export function latestValidEvidence(records: ReconciliationRecord[]): ReconciliationRecord[] {
  const latest = new Map<string, ReconciliationRecord>();
  for (const record of records) {
    if (!record.name || record.status === 'exception') continue;
    const key = record.identityKey ?? `${record.sourceType ?? ''}:${record.sourceId ?? record.name}`;
    const current = latest.get(key);
    if (!current || (record.evidenceVersion ?? 0) > (current.evidenceVersion ?? 0)) {
      latest.set(key, record);
    }
  }
  return [...latest.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function findRelationship(leftType?: string, rightType?: string) {
  return Object.values(RELATIONSHIPS).find(
    (relationship) => relationship.left === leftType && relationship.right === rightType
  );
}

function scorePair(
  left: ReconciliationRecord,
  right: ReconciliationRecord,
  relationship: (typeof RELATIONSHIPS)[string],
  pesa: (value: string | number) => Money
): ReconciliationProposal | null {
  if (left.name === right.name) return null;
  if (!left.currency || !right.currency || left.currency !== right.currency) return null;
  if (!left.transactionDate || !right.transactionDate) return null;

  const dateDeltaDays = Math.abs(left.transactionDate.getTime() - right.transactionDate.getTime()) / 86400000;
  if (dateDeltaDays > relationship.days) return null;

  const leftAmount = left[`${relationship.leftAmount}Amount`] ?? left.netAmount ?? pesa(0);
  const rightAmount = right[`${relationship.rightAmount}Amount`] ?? right.netAmount ?? pesa(0);
  const amountDelta = leftAmount.sub(rightAmount);
  if (!amountDelta.isZero()) return null;

  const reasonCodes: ReconciliationReason[] = [
    'compatible_transaction_types',
    'same_currency',
    'exact_amount',
    'date_within_window',
  ];
  const explicitReference = hasReliableReference(left, right);
  if (explicitReference) reasonCodes.push('explicit_reference');

  const confidence: ReconciliationConfidence = explicitReference
    ? 'exact'
    : dateDeltaDays <= 1
      ? 'high'
      : 'medium';
  const [first, second] = [left.name, right.name].sort();
  const edgeKey = `${first}:${second}`;
  return {
    leftRecord: first,
    rightRecord: second,
    matchType: 'imported_evidence',
    confidence,
    reasonCodes,
    amountDelta,
    dateDeltaDays,
    edgeKey,
    leftEvidenceHash: left.evidenceHash ?? '',
    rightEvidenceHash: right.evidenceHash ?? '',
    evidenceSnapshot: JSON.stringify({
      leftRecord: first,
      rightRecord: second,
      leftEvidenceHash: left.evidenceHash ?? '',
      rightEvidenceHash: right.evidenceHash ?? '',
      leftCurrency: left.currency,
      rightCurrency: right.currency,
      leftAmount: leftAmount.store,
      rightAmount: rightAmount.store,
      dateDeltaDays,
      reasonCodes,
    }),
  };
}

function hasReliableReference(left: ReconciliationRecord, right: ReconciliationRecord): boolean {
  const leftRaw = parseRaw(left.rawData);
  const rightRaw = parseRaw(right.rawData);
  const keys = ['orderId', 'order_id', 'merchantOrderId', 'paymentReference', 'transactionReference'];
  return keys.some((key) => leftRaw[key] !== undefined && rightRaw[key] !== undefined && String(leftRaw[key]) === String(rightRaw[key]));
}

function parseRaw(raw?: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}
