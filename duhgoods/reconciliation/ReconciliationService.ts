import type { Fyo } from 'fyo';
import type { DocValueMap } from 'fyo/core/types';
import { ModelNameEnum } from 'models/types';
import { Money } from 'pesa';
import {
  evaluateReconciliation,
  latestValidEvidence,
} from './ReconciliationEngine';
import type {
  ReconciliationEvaluation,
  ReconciliationProposal,
  ReconciliationRecord,
} from './ReconciliationEngine';

const IMPORT_RECORD_FIELDS = [
  'name',
  'sourceType',
  'sourceId',
  'transactionType',
  'transactionDate',
  'currency',
  'grossAmount',
  'netAmount',
  'status',
  'identityKey',
  'evidenceHash',
  'evidenceVersion',
  'rawData',
];

const MATCH_FIELDS = [
  'name',
  'leftRecord',
  'rightRecord',
  'status',
  'reviewedAt',
  'reviewedBy',
  'decisionNotes',
  'edgeKey',
  'confidence',
];

export class ReconciliationConflictError extends Error {
  constructor(
    message = 'Accepted reconciliation conflicts with an existing accepted relationship'
  ) {
    super(message);
    this.name = 'ReconciliationConflictError';
  }
}

export class DuhGoodsReconciliationService {
  constructor(private readonly fyo: Fyo) {}

  async generateProposals(): Promise<ReconciliationProposal[]> {
    return (await this.generateEvaluation()).proposals;
  }

  async generateEvaluation(): Promise<ReconciliationEvaluation> {
    const rows = await this.fyo.db.getAll(ModelNameEnum.DuhGoodsImportRecord, {
      fields: IMPORT_RECORD_FIELDS,
    });
    const evaluation = evaluateReconciliation(
      toReconciliationRecords(rows),
      (value) => this.fyo.pesa(value)
    );
    for (const proposal of evaluation.proposals)
      await this.persistProposal(proposal);
    return evaluation;
  }

  async getMatches(status?: 'proposed' | 'accepted' | 'rejected') {
    return this.fyo.db.getAll(ModelNameEnum.DuhGoodsReconciliationMatch, {
      filters: status ? { status } : undefined,
      fields: MATCH_FIELDS,
    });
  }

  async getUnmatchedRecords(): Promise<ReconciliationRecord[]> {
    const [records, accepted] = await Promise.all([
      this.fyo.db.getAll(ModelNameEnum.DuhGoodsImportRecord, {
        fields: IMPORT_RECORD_FIELDS,
      }),
      this.getMatches('accepted'),
    ]);
    const matchedNames = new Set(
      accepted.flatMap((match) => [match.leftRecord, match.rightRecord])
    );
    return latestValidEvidence(toReconciliationRecords(records)).filter(
      (record) => !matchedNames.has(record.name)
    );
  }

  async accept(matchName: string, reviewer: string): Promise<void> {
    const match = await this.fyo.doc.getDoc(
      ModelNameEnum.DuhGoodsReconciliationMatch,
      matchName
    );
    if (match.status !== 'proposed')
      throw new Error('Only proposed reconciliations can be accepted');
    const conflicts = await this.fyo.db.getAll(
      ModelNameEnum.DuhGoodsReconciliationMatch,
      {
        filters: { status: 'accepted' },
        fields: ['name', 'leftRecord', 'rightRecord'],
      }
    );
    if (
      conflicts.some(
        (row) =>
          row.leftRecord === match.leftRecord ||
          row.rightRecord === match.rightRecord ||
          row.leftRecord === match.rightRecord ||
          row.rightRecord === match.leftRecord
      )
    ) {
      throw new ReconciliationConflictError();
    }
    await match.setMultiple({
      status: 'accepted',
      reviewedAt: new Date(),
      reviewedBy: reviewer,
    });
    await match.sync();
  }

  async reject(
    matchName: string,
    reviewer: string,
    reason = ''
  ): Promise<void> {
    const match = await this.fyo.doc.getDoc(
      ModelNameEnum.DuhGoodsReconciliationMatch,
      matchName
    );
    if (match.status !== 'proposed')
      throw new Error('Only proposed reconciliations can be rejected');
    await match.setMultiple({
      status: 'rejected',
      reviewedAt: new Date(),
      reviewedBy: reviewer,
      decisionNotes: reason,
    });
    await match.sync();
  }

  private async persistProposal(
    proposal: ReconciliationProposal
  ): Promise<void> {
    const existing = await this.fyo.db.getAll(
      ModelNameEnum.DuhGoodsReconciliationMatch,
      {
        filters: { edgeKey: proposal.edgeKey },
        fields: ['name'],
        limit: 1,
      }
    );
    if (existing.length) return;
    const match = this.fyo.doc.getNewDoc(
      ModelNameEnum.DuhGoodsReconciliationMatch
    );
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

function toReconciliationRecords(rows: DocValueMap[]): ReconciliationRecord[] {
  return rows.map((row) => {
    const name = optionalString(row.name);
    if (!name)
      throw new Error(
        'DuhGoods reconciliation requires persisted import record names'
      );
    return {
      name,
      sourceType: optionalString(row.sourceType),
      sourceId: optionalString(row.sourceId),
      transactionType: optionalString(row.transactionType),
      transactionDate: optionalDate(row.transactionDate),
      currency: optionalString(row.currency),
      grossAmount: optionalMoney(row.grossAmount),
      netAmount: optionalMoney(row.netAmount),
      status: optionalString(row.status),
      identityKey: optionalString(row.identityKey),
      evidenceHash: optionalString(row.evidenceHash),
      evidenceVersion: optionalNumber(row.evidenceVersion),
      rawData: optionalString(row.rawData),
    };
  });
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function optionalDate(value: unknown): Date | undefined {
  return value instanceof Date ? value : undefined;
}

function optionalMoney(value: unknown): Money | undefined {
  return value instanceof Money ? value : undefined;
}
