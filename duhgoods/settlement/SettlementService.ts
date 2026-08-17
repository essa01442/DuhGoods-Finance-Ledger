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

/**
 * Settlement reconciliation service.
 *
 * Handles legitimate many-to-one relationships:
 *   many PSP payments/refunds/fees → one PSP settlement → one bank credit
 *
 * Algorithm (date-range, O(n log n)):
 * 1. Sort all settlements chronologically.
 * 2. For each settlement, collect all unmatched PSP payment/refund/fee records
 *    whose transactionDate falls in (prevSettlement.date, thisSettlement.date].
 * 3. If the sum of those member records ≈ settlement.netAmount within tolerance,
 *    propose the full date-range set as the settlement group.
 * 4. No exponential subset enumeration — the PSP batches in chronological order
 *    so the date range uniquely identifies each settlement period.
 *
 * Settlement groups are persisted as first-class DuhGoodsSettlementGroup records
 * with DB-level uniqueness on settlementRecord and status lifecycle
 * (open → closed, or closed → reopened).
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

    // Sort settlements chronologically so prevSettlementDate advances correctly.
    settlements.sort(
      (a, b) => a.transactionDate.getTime() - b.transactionDate.getTime()
    );

    const proposals: SettlementGroupProposal[] = [];
    // Track the most recent settlement date per currency for period boundary.
    const prevSettlementDate = new Map<string, Date>();

    for (const settlement of settlements) {
      const currency = settlement.currency;
      const periodStart = prevSettlementDate.get(currency) ?? new Date(0);

      // Collect all PSP members in the half-open interval (periodStart, settlementDate].
      const membersInRange = memberCandidates.filter(
        (m) =>
          m.currency === currency &&
          m.transactionDate.getTime() > periodStart.getTime() &&
          m.transactionDate.getTime() <= settlement.transactionDate.getTime()
      );

      prevSettlementDate.set(currency, settlement.transactionDate);

      if (membersInRange.length === 0) continue;

      const totalMemberNet = membersInRange.reduce(
        (s, m) => s.add(m.netAmount),
        pesa(0)
      );
      const target = settlement.netAmount;
      const tolerance = pesa(SETTLEMENT_TOLERANCE);
      const delta = target.sub(totalMemberNet).abs();

      if (!delta.lte(tolerance)) continue; // date-range sum doesn't match — leave for manual review

      proposals.push({
        settlementRecord: settlement,
        memberRecords: membersInRange,
        totalMemberNet,
        settlementNet: target,
        delta,
        confidence: delta.isZero() ? 'exact' : 'within_tolerance',
        // Date-range matching produces exactly one candidate set per settlement
        // period; there are no alternative subsets to be ambiguous about.
        ambiguous: false,
        alternativeCount: 1,
      });
    }

    return proposals;
  }

  /**
   * Accepts a settlement group proposal.
   *
   * Creates a DuhGoodsSettlementGroup record (idempotent — skipped if one already
   * exists for the same settlementRecord). Creates one DuhGoodsReconciliationMatch
   * per member→settlement pair, each linked to the group via settlementGroup.
   * Marks all member and settlement import records as 'reconciled'.
   * Sets the group status to 'closed' once all members are reconciled.
   *
   * Throws on ambiguous proposals — human review required.
   */
  async acceptGroup(
    proposal: SettlementGroupProposal,
    reviewer: string
  ): Promise<string> {
    if (proposal.ambiguous) {
      throw new Error(
        'Cannot auto-accept an ambiguous settlement group — human review required'
      );
    }

    const { settlementRecord, memberRecords } = proposal;

    // Idempotency: check if a settlement group already exists for this settlement.
    const existingGroups = await this.fyo.db.getAll(
      ModelNameEnum.DuhGoodsSettlementGroup,
      {
        filters: { settlementRecord: settlementRecord.name },
        fields: ['name', 'status'],
        limit: 1,
      }
    );

    let groupName: string;
    if (existingGroups.length > 0) {
      groupName = existingGroups[0].name as string;
    } else {
      const now = new Date();
      const group = this.fyo.doc.getNewDoc(ModelNameEnum.DuhGoodsSettlementGroup);
      await group.setMultiple({
        settlementRecord: settlementRecord.name,
        currency: settlementRecord.currency,
        memberCount: memberRecords.length,
        totalMemberNet: proposal.totalMemberNet,
        settlementNet: proposal.settlementNet,
        delta: proposal.delta,
        confidence: proposal.confidence,
        status: 'open',
        reviewedBy: reviewer,
        reviewedAt: now,
        evidenceSnapshot: JSON.stringify({
          settlementName: settlementRecord.name,
          settlementDate: settlementRecord.transactionDate.toISOString(),
          memberCount: memberRecords.length,
          members: memberRecords.map((m) => ({
            name: m.name,
            type: m.transactionType,
            amount: m.netAmount.store,
            date: m.transactionDate.toISOString(),
          })),
          totalMemberNet: proposal.totalMemberNet.store,
          settlementNet: proposal.settlementNet.store,
          delta: proposal.delta.store,
          confidence: proposal.confidence,
        }),
      });
      await group.sync();
      groupName = group.name as string;
    }

    // Idempotency: skip members already reconciled (partial re-run protection).
    const settlementRow = await this.fyo.db.get(
      ModelNameEnum.DuhGoodsImportRecord,
      settlementRecord.name
    );
    if ((settlementRow as Record<string, unknown>)?.status === 'reconciled') {
      return groupName;
    }

    const now = new Date();

    for (const member of memberRecords) {
      const existing = await this.fyo.db.getAll(
        ModelNameEnum.DuhGoodsReconciliationMatch,
        {
          filters: {
            leftRecord: member.name,
            rightRecord: settlementRecord.name,
          },
          fields: ['name'],
          limit: 1,
        }
      );
      if (existing.length > 0) continue;

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
        settlementGroup: groupName,
        reasonCodes: JSON.stringify(['settlement_member']),
        amountDelta: proposal.delta,
        dateDeltaDays: Math.abs(
          (settlementRecord.transactionDate.getTime() -
            member.transactionDate.getTime()) /
            86400000
        ),
        evidenceSnapshot: JSON.stringify({
          groupName,
          member: {
            name: member.name,
            type: member.transactionType,
            amount: member.netAmount.store,
          },
          settlement: {
            name: settlementRecord.name,
            type: settlementRecord.transactionType,
            amount: settlementRecord.netAmount.store,
          },
          delta: proposal.delta.store,
          confidence: proposal.confidence,
        }),
        decisionNotes:
          `Settlement group ${groupName} accepted by ${reviewer}. ` +
          `${memberRecords.length} member(s). Total: ${proposal.totalMemberNet.store} ${settlementRecord.currency}.`,
      });
      await match.sync();

      const memberDoc = await this.fyo.doc.getDoc(
        ModelNameEnum.DuhGoodsImportRecord,
        member.name
      );
      await memberDoc.setMultiple({ status: 'reconciled' });
      await memberDoc.sync();
    }

    const settlementDoc = await this.fyo.doc.getDoc(
      ModelNameEnum.DuhGoodsImportRecord,
      settlementRecord.name
    );
    await settlementDoc.setMultiple({ status: 'reconciled' });
    await settlementDoc.sync();

    await this.closeGroup(groupName);
    return groupName;
  }

  /**
   * Marks a settlement group as closed.
   * Idempotent: if already closed, returns without error.
   */
  async closeGroup(groupName: string): Promise<void> {
    const group = await this.fyo.doc.getDoc(
      ModelNameEnum.DuhGoodsSettlementGroup,
      groupName,
      { skipDocumentCache: true }
    );
    if (group.status === 'closed') return;
    await group.setMultiple({
      status: 'closed',
      closedAt: new Date(),
    });
    await group.sync();
  }

  /**
   * Reopens a closed settlement group for further review.
   * Transitions status: closed → reopened.
   */
  async reopenGroup(groupName: string): Promise<void> {
    const group = await this.fyo.doc.getDoc(
      ModelNameEnum.DuhGoodsSettlementGroup,
      groupName,
      { skipDocumentCache: true }
    );
    if (group.status !== 'closed') {
      throw new Error(
        `Settlement group ${groupName} is ${String(group.status)}, not closed — cannot reopen`
      );
    }
    await group.set('status', 'reopened');
    await group.sync();
  }

  private edgeKey(a: string, b: string): string {
    const [min, max] = a < b ? [a, b] : [b, a];
    return `${min}:${max}`;
  }
}
