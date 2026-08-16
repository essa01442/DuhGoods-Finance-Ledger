import type { Money } from 'pesa';

export type ReconciliationConfidence = 'exact' | 'high' | 'medium' | 'low';
export type ReconciliationReason =
  | 'compatible_transaction_types'
  | 'same_currency'
  | 'exact_amount'
  | 'date_within_window'
  | 'explicit_reference'
  | 'different_currency_requires_fx'
  | 'date_outside_window'
  | 'amount_mismatch'
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

type Relationship = {
  left: string;
  right: string;
  leftSource: string;
  rightSource: string;
  days: number;
  leftAmount: 'gross' | 'net';
  rightAmount: 'gross' | 'net';
};

const RELATIONSHIPS: Relationship[] = [
  { left: 'order', right: 'payment', leftSource: 'woocommerce', rightSource: 'psp_export', days: 3, leftAmount: 'gross', rightAmount: 'gross' },
  { left: 'refund', right: 'refund', leftSource: 'woocommerce', rightSource: 'psp_export', days: 3, leftAmount: 'net', rightAmount: 'net' },
  { left: 'settlement', right: 'bank_credit', leftSource: 'psp_export', rightSource: 'bank_statement', days: 7, leftAmount: 'net', rightAmount: 'net' },
  { left: 'chargeback', right: 'bank_debit', leftSource: 'psp_export', rightSource: 'bank_statement', days: 14, leftAmount: 'net', rightAmount: 'net' },
];

export function generateReconciliationProposals(
  records: ReconciliationRecord[],
  pesa: (value: string | number) => Money
): ReconciliationProposal[] {
  const latest = latestValidEvidence(records);
  const proposals: ReconciliationProposal[] = [];

  for (const left of latest) {
    for (const right of latest) {
      if (left.name >= right.name) continue;
      for (const relationship of RELATIONSHIPS) {
        const ordered = orderPair(left, right, relationship);
        if (!ordered) continue;
        const proposal = scorePair(ordered[0], ordered[1], relationship, pesa);
        if (proposal) proposals.push(proposal);
      }
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

function orderPair(left: ReconciliationRecord, right: ReconciliationRecord, relationship: Relationship): [ReconciliationRecord, ReconciliationRecord] | null {
  if (left.transactionType === relationship.left && left.sourceType === relationship.leftSource && right.transactionType === relationship.right && right.sourceType === relationship.rightSource) return [left, right];
  if (right.transactionType === relationship.left && right.sourceType === relationship.leftSource && left.transactionType === relationship.right && left.sourceType === relationship.rightSource) return [right, left];
  return null;
}

function scorePair(left: ReconciliationRecord, right: ReconciliationRecord, relationship: Relationship, pesa: (value: string | number) => Money): ReconciliationProposal | null {
  if (left.name === right.name || !left.currency || !right.currency || left.currency !== right.currency) return null;
  if (!left.transactionDate || !right.transactionDate) return null;

  const dateDeltaDays = Math.abs(left.transactionDate.getTime() - right.transactionDate.getTime()) / 86400000;
  if (dateDeltaDays > relationship.days) return null;

  const leftAmount = getAmount(left, relationship.leftAmount, pesa);
  const rightAmount = getAmount(right, relationship.rightAmount, pesa);
  const amountDelta = leftAmount.sub(rightAmount);
  if (!amountDelta.isZero()) return null;

  const reasonCodes: ReconciliationReason[] = ['compatible_transaction_types', 'same_currency', 'exact_amount', 'date_within_window'];
  if (hasReliableReference(left, right)) reasonCodes.push('explicit_reference');

  const confidence: ReconciliationConfidence = reasonCodes.includes('explicit_reference') ? 'exact' : dateDeltaDays <= 1 ? 'high' : 'medium';
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

function getAmount(record: ReconciliationRecord, kind: 'gross' | 'net', pesa: (value: string | number) => Money): Money {
  if (kind === 'gross' && record.grossAmount) return record.grossAmount;
  if (record.netAmount) return record.netAmount;
  return pesa(0);
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
