import { Doc } from 'fyo/model/doc';
import { ListViewSettings } from 'fyo/model/types';
import { Money } from 'pesa';

const IMMUTABLE_FIELDS = [
  'importRecord',
  'matchType',
  'matchedDocument',
  'matchedDocumentType',
  'leftRecord',
  'rightRecord',
  'edgeKey',
  'matchedAt',
  'amountDelta',
  'dateDeltaDays',
  'leftEvidenceHash',
  'rightEvidenceHash',
  'evidenceSnapshot',
] as const;
const PROPOSAL_LIFECYCLE_FIELDS = [
  'confidence',
  'reasonCodes',
  'assessmentHistory',
  'supersededAt',
] as const;

export class DuhGoodsReconciliationMatch extends Doc {
  importRecord?: string;
  matchType?: string;
  matchedDocument?: string;
  matchedDocumentType?: string;
  leftRecord?: string;
  rightRecord?: string;
  edgeKey?: string;
  confidence?: string;
  status?: string;
  matchedAt?: Date;
  amountDelta?: Money;
  dateDeltaDays?: number;
  reasonCodes?: string;
  assessmentHistory?: string;
  supersededAt?: Date;
  leftEvidenceHash?: string;
  rightEvidenceHash?: string;
  evidenceSnapshot?: string;
  reviewedAt?: Date;
  reviewedBy?: string;
  decisionNotes?: string;
  settlementGroup?: string;
  notes?: string;

  static override getListViewSettings(): ListViewSettings {
    return {
      columns: [
        'leftRecord',
        'rightRecord',
        'confidence',
        'status',
        'amountDelta',
        'dateDeltaDays',
      ],
    };
  }

  override async beforeSync(): Promise<void> {
    if (this.notInserted) return;
    const stored = await this.fyo.db.get(this.schemaName, this.name as string);
    for (const field of IMMUTABLE_FIELDS) {
      if (
        !sameImmutableValue(
          stored[field],
          (this as Record<string, unknown>)[field]
        )
      ) {
        throw new Error(
          `DuhGoodsReconciliationMatch: field "${field}" is evidence-immutable and cannot be changed`
        );
      }
    }
    if (stored.status !== 'proposed' && this.status !== stored.status) {
      throw new Error('A reviewed reconciliation decision cannot be changed');
    }
    if (stored.status !== 'proposed') {
      for (const field of PROPOSAL_LIFECYCLE_FIELDS) {
        if (
          !sameImmutableValue(
            stored[field],
            (this as Record<string, unknown>)[field]
          )
        ) {
          throw new Error(
            `DuhGoodsReconciliationMatch: field "${field}" cannot be changed after review`
          );
        }
      }
    }
    if (this.status !== 'accepted') return;
    const accepted = await this.fyo.db.getAll(this.schemaName, {
      filters: { status: 'accepted' },
      fields: ['name', 'leftRecord', 'rightRecord'],
    });
    const conflict = accepted.some(
      (row) =>
        row.name !== this.name &&
        (row.leftRecord === this.leftRecord ||
          row.rightRecord === this.rightRecord ||
          row.leftRecord === this.rightRecord ||
          row.rightRecord === this.leftRecord)
    );
    if (conflict)
      throw new Error(
        'Accepted reconciliation conflicts with an existing accepted relationship'
      );
  }
}

function sameImmutableValue(stored: unknown, current: unknown): boolean {
  if (stored == null && current == null) return true;
  if (stored == null || current == null) return false;

  const storedIsMoney =
    typeof stored === 'object' && stored !== null && 'store' in stored;
  const currentIsMoney =
    typeof current === 'object' && current !== null && 'store' in current;
  if (storedIsMoney && currentIsMoney)
    return (stored as Money).store === (current as Money).store;
  if (storedIsMoney) return (stored as Money).store === String(current);
  if (currentIsMoney) return String(stored) === (current as Money).store;

  if (stored instanceof Date && current instanceof Date)
    return stored.getTime() === current.getTime();
  if (stored instanceof Date || current instanceof Date) {
    const storedDate = new Date(String(stored));
    const currentDate = new Date(String(current));
    return (
      !Number.isNaN(storedDate.getTime()) &&
      storedDate.getTime() === currentDate.getTime()
    );
  }

  return String(stored) === String(current);
}
