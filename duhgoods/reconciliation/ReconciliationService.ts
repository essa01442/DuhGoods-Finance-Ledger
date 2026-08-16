import type { Fyo } from 'fyo';
import { ModelNameEnum } from 'models/types';
import { generateReconciliationProposals, type ReconciliationProposal, type ReconciliationRecord } from './ReconciliationEngine';

export class ReconciliationConflictError extends Error {
  constructor(message = 'Accepted reconciliation conflicts with an existing accepted relationship') {
    super(message);
    this.name = 'ReconciliationConflictError';
  }
}

export class DuhGoodsReconciliationService {
  constructor(private readonly fyo: Fyo) {}

  async generateProposals(): Promise<ReconciliationProposal[]> {
    const rows = await this.fyo.db.getAll(ModelNameEnum.DuhGoodsImportRecord, {
      fields: [
        'name', 'sourceType', 'sourceId', 'transactionType', 'transactionDate',
        'currency', 'grossAmount', 'netAmount', 'status', 'identityKey',
        'evidenceHash', 'evidenceVersion', 'rawData',
      ],
    });
    const proposals = generateReconciliationProposals(rows as ReconciliationRecord[], (value) => this.fyo.pesa(value));
    for (const proposal of proposals) await this.persistProposal(proposal);
    return proposals;
  }

  async accept(matchName: string, reviewer: string): Promise<void> {
    const match = await this.fyo.doc.getDoc(ModelNameEnum.DuhGoodsReconciliationMatch, matchName);
    if (match.status !== 'proposed') throw new Error('Only proposed reconciliations can be accepted');
    const conflicts = await this.fyo.db.getAll(ModelNameEnum.DuhGoodsReconciliationMatch, {
      filters: { status: 'accepted' },
      fields: ['name', 'leftRecord', 'rightRecord'],
    });
    if (conflicts.some((row) => row.leftRecord === match.leftRecord || row.rightRecord === match.rightRecord || row.leftRecord === match.rightRecord || row.rightRecord === match.leftRecord)) {
      throw new ReconciliationConflictError();
    }
    await match.setMultiple({ status: 'accepted', reviewedAt: new Date(), reviewedBy: reviewer });
    await match.sync();
  }

  async reject(matchName: string, reviewer: string, reason = ''): Promise<void> {
    const match = await this.fyo.doc.getDoc(ModelNameEnum.DuhGoodsReconciliationMatch, matchName);
    if (match.status !== 'proposed') throw new Error('Only proposed reconciliations can be rejected');
    await match.setMultiple({ status: 'rejected', reviewedAt: new Date(), reviewedBy: reviewer, decisionNotes: reason });
    await match.sync();
  }

  private async persistProposal(proposal: ReconciliationProposal): Promise<void> {
    const existing = await this.fyo.db.getAll(ModelNameEnum.DuhGoodsReconciliationMatch, {
      filters: { edgeKey: proposal.edgeKey }, fields: ['name'], limit: 1,
    });
    if (existing.length) return;
    const match = this.fyo.doc.getNewDoc(ModelNameEnum.DuhGoodsReconciliationMatch);
    await match.setMultiple({
      importRecord: proposal.leftRecord,
      matchType: proposal.matchType,
      matchedDocument: proposal.rightRecord,
      matchedDocumentType: ModelNameEnum.DuhGoodsImportRecord,
      leftRecord: proposal.leftRecord,
      rightRecord: proposal.rightRecord,
      edgeKey: proposal.edgeKey,
      confidence: proposal.confidence,
      status: 'proposed',
      matchedAt: new Date(),
      amountDelta: proposal.amountDelta,
      dateDeltaDays: proposal.dateDeltaDays,
      reasonCodes: proposal.reasonCodes.join(','),
      leftEvidenceHash: proposal.leftEvidenceHash,
      rightEvidenceHash: proposal.rightEvidenceHash,
      evidenceSnapshot: proposal.evidenceSnapshot,
    });
    await match.sync();
  }
}
