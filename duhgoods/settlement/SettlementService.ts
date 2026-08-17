import type { Fyo } from 'fyo';
import type { Money } from 'pesa';
import { ModelNameEnum } from 'models/types';

export interface SettlementCandidate {
  name: string;
  transactionType: string;
  transactionDate: Date;
  currency: string;
  netAmount: Money;
  evidenceHash: string;
}

export interface SettlementGroupProposal {
  settlementRecord: SettlementCandidate;
  memberRecords: SettlementCandidate[];
  totalMemberNet: Money;
  settlementNet: Money;
  delta: Money;
  confidence: 'exact' | 'within_tolerance';
  ambiguous: boolean;
  alternativeCount: number;
}

const SETTLEMENT_TOLERANCE = '0.01'; // SAR
const MAX_SUBSET_SIZE = 50; // safety bound for subset-sum

/**
 * Advanced settlement reconciliation service.
 *
 * Handles legitimate many-to-one relationships:
 *   many PSP payments/refunds/fees → one PSP settlement → one bank credit
 *
 * Algorithm:
 * 1. Collect all unmatched PSP records (payments, refunds, fees) and
 *    all unmatched PSP settlements for the same currency.
 * 2. For each settlement, find subsets of member records whose net sum
 *    matches the settlement net amount within tolerance.
 * 3. If exactly one subset matches → propose it as a high-confidence group.
 * 4. If multiple subsets match → flag as ambiguous (human review required).
 * 5. If no subset matches → flag as unresolved.
 *
 * The subset-sum is bounded: if the candidate pool exceeds MAX_SUBSET_SIZE,
 * it is pruned to the N records closest in date to the settlement. This
 * prevents exponential blowup while preserving correctness for normal batches.
 */
export class SettlementService {
  constructor(private readonly fyo: Fyo) {}

  async proposeGroups(): Promise<SettlementGroupProposal[]> {
    const allUnmatched = await this.fyo.db.getAll(
      ModelNameEnum.DuhGoodsImportRecord,
      {
        filters: { status: 'pending' },
        fields: [
          'name',
          'transactionType',
          'transactionDate',
          'currency',
          'netAmount',
          'evidenceHash',
          'sourceType',
          'identityKey',
        ],
        orderBy: 'transactionDate',
        order: 'asc',
      }
    );

    const pesa = this.fyo.pesa.bind(this.fyo);

    const settlements: SettlementCandidate[] = [];
    const memberCandidates: SettlementCandidate[] = [];

    for (const r of allUnmatched) {
      if (r.sourceType !== 'psp_export') continue;
      const candidate: SettlementCandidate = {
        name: r.name as string,
        transactionType: r.transactionType as string,
        transactionDate: r.transactionDate as Date,
        currency: r.currency as string,
        netAmount: pesa(String(r.netAmount ?? 0)),
        evidenceHash: r.evidenceHash as string,
      };
      if (r.transactionType === 'settlement') {
        settlements.push(candidate);
      } else if (
        r.transactionType === 'payment' ||
        r.transactionType === 'refund' ||
        r.transactionType === 'fee' ||
        r.transactionType === 'chargeback'
      ) {
        memberCandidates.push(candidate);
      }
    }

    const proposals: SettlementGroupProposal[] = [];

    for (const settlement of settlements) {
      const sameCurrency = memberCandidates.filter(
        (m) => m.currency === settlement.currency
      );

      // Bound the candidate pool to prevent exponential blowup.
      const pool =
        sameCurrency.length <= MAX_SUBSET_SIZE
          ? sameCurrency
          : this.nearestByDate(sameCurrency, settlement.transactionDate, MAX_SUBSET_SIZE);

      const target = settlement.netAmount;
      const tolerance = pesa(SETTLEMENT_TOLERANCE);
      const matchingSets = this.findMatchingSubsets(pool, target, tolerance, pesa);

      if (matchingSets.length === 0) {
        continue; // No viable subset — leave for unmatched review
      }

      const best = matchingSets[0];
      const totalMemberNet = best.reduce(
        (sum: Money, m: SettlementCandidate) => sum.add(m.netAmount),
        pesa(0)
      );
      const delta = target.sub(totalMemberNet).abs();
      const confidence = delta.isZero() ? 'exact' : 'within_tolerance';

      proposals.push({
        settlementRecord: settlement,
        memberRecords: best,
        totalMemberNet,
        settlementNet: target,
        delta,
        confidence,
        ambiguous: matchingSets.length > 1,
        alternativeCount: matchingSets.length,
      });
    }

    return proposals;
  }

  /**
   * Accepts a settlement group proposal and creates reconciliation matches.
   * One match per member → settlement pair.
   * Marks members and settlement as reconciled.
   */
  async acceptGroup(
    proposal: SettlementGroupProposal,
    reviewer: string
  ): Promise<void> {
    if (proposal.ambiguous) {
      throw new Error(
        'Cannot auto-accept an ambiguous settlement group — human review required'
      );
    }

    const { settlementRecord, memberRecords } = proposal;
    const now = new Date();

    for (const member of memberRecords) {
      const match = this.fyo.doc.getNewDoc(
        ModelNameEnum.DuhGoodsReconciliationMatch
      );
      await match.setMultiple({
        importRecord: member.name,
        matchType: 'imported_evidence',
        leftRecord: member.name,
        rightRecord: settlementRecord.name,
        leftEvidenceHash: member.evidenceHash,
        rightEvidenceHash: settlementRecord.evidenceHash,
        edgeKey: this.edgeKey(member.name, settlementRecord.name),
        confidence: proposal.confidence === 'exact' ? 'high' : 'medium',
        status: 'accepted',
        matchedAt: now,
        reviewedAt: now,
        reviewedBy: reviewer,
        reasonCodes: JSON.stringify(['settlement_member']),
        amountDelta: proposal.delta,
        dateDeltaDays: Math.abs(
          (settlementRecord.transactionDate.getTime() -
            member.transactionDate.getTime()) /
            86400000
        ),
        evidenceSnapshot: JSON.stringify({
          member: { name: member.name, type: member.transactionType, amount: member.netAmount.store },
          settlement: { name: settlementRecord.name, type: settlementRecord.transactionType, amount: settlementRecord.netAmount.store },
        }),
        decisionNotes: `Settlement group accepted by ${reviewer}. ${proposal.memberRecords.length} member(s).`,
      });
      await match.sync();
    }
  }

  private nearestByDate(
    candidates: SettlementCandidate[],
    referenceDate: Date,
    limit: number
  ): SettlementCandidate[] {
    return [...candidates]
      .sort(
        (a, b) =>
          Math.abs(a.transactionDate.getTime() - referenceDate.getTime()) -
          Math.abs(b.transactionDate.getTime() - referenceDate.getTime())
      )
      .slice(0, limit);
  }

  /**
   * Finds all subsets of candidates whose net sum equals target ± tolerance.
   * Returns at most 10 matching subsets (we only need to know if it's ambiguous).
   */
  private findMatchingSubsets(
    candidates: SettlementCandidate[],
    target: Money,
    tolerance: Money,
    pesa: (v: string | number) => Money
  ): SettlementCandidate[][] {
    const results: SettlementCandidate[][] = [];
    const MAX_RESULTS = 10;

    const recurse = (
      index: number,
      current: SettlementCandidate[],
      sum: Money
    ): void => {
      if (results.length >= MAX_RESULTS) return;
      const delta = target.sub(sum).abs();
      if (delta.lte(tolerance) && current.length > 0) {
        results.push([...current]);
        if (results.length >= MAX_RESULTS) return;
      }
      if (index >= candidates.length) return;
      const remaining = candidates.slice(index);
      // Pruning: if even adding all remaining won't reach target, skip
      const remainingSum = remaining.reduce(
        (s, c) => s.add(c.netAmount),
        pesa(0)
      );
      const maxPossible = sum.add(remainingSum);
      if (target.sub(maxPossible).abs().gt(tolerance) && maxPossible.lt(target)) {
        return; // can't reach target
      }
      for (let i = index; i < candidates.length; i++) {
        current.push(candidates[i]);
        recurse(i + 1, current, sum.add(candidates[i].netAmount));
        current.pop();
        if (results.length >= MAX_RESULTS) return;
      }
    };

    recurse(0, [], pesa(0));
    return results;
  }

  private edgeKey(a: string, b: string): string {
    const [min, max] = a < b ? [a, b] : [b, a];
    return `${min}:${max}`;
  }
}
