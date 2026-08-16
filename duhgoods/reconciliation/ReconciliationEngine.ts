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
  | 'ambiguous_candidates'
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

export interface ReconciliationOutcome {
  leftRecord: string;
  rightRecord: string;
  outcome: 'requires_future_fx';
  reasonCodes: ReconciliationReason[];
}

export interface ReconciliationEvaluation {
  proposals: ReconciliationProposal[];
  outcomes: ReconciliationOutcome[];
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
  leftDirection: 'positive' | 'negative' | 'nonzero';
  rightDirection: 'positive' | 'negative' | 'nonzero';
  compareMagnitude: boolean;
};

const RELATIONSHIPS: Relationship[] = [
  {
    left: 'order',
    right: 'payment',
    leftSource: 'woocommerce',
    rightSource: 'psp_export',
    days: RECONCILIATION_WINDOWS_DAYS.orderPayment,
    leftAmount: 'gross',
    rightAmount: 'gross',
    leftDirection: 'positive',
    rightDirection: 'positive',
    compareMagnitude: false,
  },
  {
    left: 'refund',
    right: 'refund',
    leftSource: 'woocommerce',
    rightSource: 'psp_export',
    days: RECONCILIATION_WINDOWS_DAYS.refundRefund,
    leftAmount: 'net',
    rightAmount: 'net',
    leftDirection: 'negative',
    rightDirection: 'nonzero',
    compareMagnitude: true,
  },
  {
    left: 'settlement',
    right: 'bank_credit',
    leftSource: 'psp_export',
    rightSource: 'bank_statement',
    days: RECONCILIATION_WINDOWS_DAYS.settlementBankCredit,
    leftAmount: 'net',
    rightAmount: 'net',
    leftDirection: 'positive',
    rightDirection: 'positive',
    compareMagnitude: false,
  },
  {
    left: 'chargeback',
    right: 'bank_debit',
    leftSource: 'psp_export',
    rightSource: 'bank_statement',
    days: RECONCILIATION_WINDOWS_DAYS.chargebackBankDebit,
    leftAmount: 'net',
    rightAmount: 'net',
    leftDirection: 'nonzero',
    rightDirection: 'negative',
    compareMagnitude: true,
  },
];

export function generateReconciliationProposals(
  records: ReconciliationRecord[],
  pesa: (value: string | number) => Money
): ReconciliationProposal[] {
  return evaluateReconciliation(records, pesa).proposals;
}

export function evaluateReconciliation(
  records: ReconciliationRecord[],
  pesa: (value: string | number) => Money
): ReconciliationEvaluation {
  const latest = latestValidEvidence(records);
  const proposals: ReconciliationProposal[] = [];
  const outcomes: ReconciliationOutcome[] = [];

  for (const left of latest) {
    for (const right of latest) {
      if (left.name >= right.name) continue;
      for (const relationship of RELATIONSHIPS) {
        const ordered = orderPair(left, right, relationship);
        if (!ordered) continue;
        const outcome = getCurrencyOutcome(ordered[0], ordered[1]);
        if (outcome) {
          outcomes.push(outcome);
          continue;
        }
        const proposal = scorePair(ordered[0], ordered[1], relationship, pesa);
        if (proposal) proposals.push(proposal);
      }
    }
  }

  return {
    proposals: applyAmbiguityConfidence(proposals).sort((a, b) =>
      a.edgeKey.localeCompare(b.edgeKey)
    ),
    outcomes: outcomes.sort((a, b) =>
      `${a.leftRecord}:${a.rightRecord}`.localeCompare(
        `${b.leftRecord}:${b.rightRecord}`
      )
    ),
  };
}

export function latestValidEvidence(
  records: ReconciliationRecord[]
): ReconciliationRecord[] {
  const latest = new Map<string, ReconciliationRecord>();
  for (const record of records) {
    if (!record.name) continue;
    const key =
      record.identityKey ??
      `${record.sourceType ?? ''}:${record.sourceId ?? record.name}`;
    const current = latest.get(key);
    if (
      !current ||
      (record.evidenceVersion ?? 0) > (current.evidenceVersion ?? 0)
    ) {
      latest.set(key, record);
    }
  }
  return [...latest.values()]
    .filter((record) => record.status !== 'exception')
    .sort((a, b) => a.name.localeCompare(b.name));
}

function orderPair(
  left: ReconciliationRecord,
  right: ReconciliationRecord,
  relationship: Relationship
): [ReconciliationRecord, ReconciliationRecord] | null {
  if (
    left.transactionType === relationship.left &&
    left.sourceType === relationship.leftSource &&
    right.transactionType === relationship.right &&
    right.sourceType === relationship.rightSource
  )
    return [left, right];
  if (
    right.transactionType === relationship.left &&
    right.sourceType === relationship.leftSource &&
    left.transactionType === relationship.right &&
    left.sourceType === relationship.rightSource
  )
    return [right, left];
  return null;
}

function scorePair(
  left: ReconciliationRecord,
  right: ReconciliationRecord,
  relationship: Relationship,
  pesa: (value: string | number) => Money
): ReconciliationProposal | null {
  if (
    left.name === right.name ||
    !left.currency ||
    !right.currency ||
    left.currency !== right.currency
  )
    return null;
  if (!left.transactionDate || !right.transactionDate) return null;

  const dateDeltaDays =
    Math.abs(left.transactionDate.getTime() - right.transactionDate.getTime()) /
    86400000;
  if (dateDeltaDays > relationship.days) return null;

  const leftAmount = getAmount(left, relationship.leftAmount, pesa);
  const rightAmount = getAmount(right, relationship.rightAmount, pesa);
  if (
    !hasDirection(leftAmount, relationship.leftDirection) ||
    !hasDirection(rightAmount, relationship.rightDirection)
  )
    return null;
  const leftEconomicAmount = relationship.compareMagnitude
    ? leftAmount.abs()
    : leftAmount;
  const rightEconomicAmount = relationship.compareMagnitude
    ? rightAmount.abs()
    : rightAmount;
  const amountDelta = leftEconomicAmount.sub(rightEconomicAmount);
  if (!amountDelta.isZero()) return null;

  const reasonCodes: ReconciliationReason[] = [
    'compatible_transaction_types',
    'same_currency',
    'exact_amount',
    'date_within_window',
  ];
  if (hasReliableReference(left, right)) reasonCodes.push('explicit_reference');

  const confidence: ReconciliationConfidence = reasonCodes.includes(
    'explicit_reference'
  )
    ? 'exact'
    : dateDeltaDays <= 1
    ? 'high'
    : 'medium';
  const [first, second] = [left.name, right.name].sort();
  const firstRecord = left.name === first ? left : right;
  const secondRecord = left.name === first ? right : left;
  const firstAmount =
    left.name === first ? leftEconomicAmount : rightEconomicAmount;
  const secondAmount =
    left.name === first ? rightEconomicAmount : leftEconomicAmount;
  const edgeKey = `${first}:${second}`;
  return {
    leftRecord: first,
    rightRecord: second,
    matchType: 'imported_evidence',
    confidence,
    reasonCodes,
    amountDelta: firstAmount.sub(secondAmount),
    dateDeltaDays,
    edgeKey,
    leftEvidenceHash: firstRecord.evidenceHash ?? '',
    rightEvidenceHash: secondRecord.evidenceHash ?? '',
    evidenceSnapshot: JSON.stringify({
      leftRecord: first,
      rightRecord: second,
      leftEvidenceHash: firstRecord.evidenceHash ?? '',
      rightEvidenceHash: secondRecord.evidenceHash ?? '',
      leftCurrency: firstRecord.currency,
      rightCurrency: secondRecord.currency,
      leftAmount: firstAmount.store,
      rightAmount: secondAmount.store,
      dateDeltaDays,
      reasonCodes,
    }),
  };
}

function applyAmbiguityConfidence(
  proposals: ReconciliationProposal[]
): ReconciliationProposal[] {
  const candidateCounts = new Map<string, number>();
  for (const proposal of proposals) {
    candidateCounts.set(
      proposal.leftRecord,
      (candidateCounts.get(proposal.leftRecord) ?? 0) + 1
    );
    candidateCounts.set(
      proposal.rightRecord,
      (candidateCounts.get(proposal.rightRecord) ?? 0) + 1
    );
  }
  return proposals.map((proposal) => {
    if (
      proposal.confidence === 'high' &&
      ((candidateCounts.get(proposal.leftRecord) ?? 0) > 1 ||
        (candidateCounts.get(proposal.rightRecord) ?? 0) > 1)
    ) {
      return {
        ...proposal,
        confidence: 'medium',
        reasonCodes: [...proposal.reasonCodes, 'ambiguous_candidates'],
      };
    }
    return proposal;
  });
}

function getCurrencyOutcome(
  left: ReconciliationRecord,
  right: ReconciliationRecord
): ReconciliationOutcome | null {
  if (!left.currency || !right.currency || left.currency === right.currency)
    return null;
  const [leftRecord, rightRecord] = [left.name, right.name].sort();
  return {
    leftRecord,
    rightRecord,
    outcome: 'requires_future_fx',
    reasonCodes: [
      'compatible_transaction_types',
      'different_currency_requires_fx',
    ],
  };
}

function getAmount(
  record: ReconciliationRecord,
  kind: 'gross' | 'net',
  pesa: (value: string | number) => Money
): Money {
  if (kind === 'gross' && record.grossAmount) return record.grossAmount;
  if (record.netAmount) return record.netAmount;
  return pesa(0);
}

function hasDirection(
  amount: Money,
  direction: 'positive' | 'negative' | 'nonzero'
): boolean {
  if (direction === 'positive') return amount.isPositive();
  if (direction === 'negative') return amount.isNegative();
  return !amount.isZero();
}

function hasReliableReference(
  left: ReconciliationRecord,
  right: ReconciliationRecord
): boolean {
  const leftRaw = parseRaw(left.rawData);
  const rightRaw = parseRaw(right.rawData);
  const keys = [
    'orderId',
    'order_id',
    'merchantOrderId',
    'paymentReference',
    'transactionReference',
  ];
  return keys.some(
    (key) =>
      leftRaw[key] !== undefined &&
      rightRaw[key] !== undefined &&
      String(leftRaw[key]) === String(rightRaw[key])
  );
}

function parseRaw(raw?: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
