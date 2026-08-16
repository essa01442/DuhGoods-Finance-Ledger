import { Doc } from 'fyo/model/doc';
import { ListViewSettings } from 'fyo/model/types';
import { Money } from 'pesa';

const IMMUTABLE_FIELDS = [
  'importRecord', 'matchType', 'matchedDocument', 'matchedDocumentType',
  'leftRecord', 'rightRecord', 'edgeKey', 'confidence', 'matchedAt',
  'amountDelta', 'dateDeltaDays', 'reasonCodes', 'leftEvidenceHash',
  'rightEvidenceHash', 'evidenceSnapshot',
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
  leftEvidenceHash?: string;
  rightEvidenceHash?: string;
  evidenceSnapshot?: string;
  reviewedAt?: Date;
  reviewedBy?: string;
  decisionNotes?: string;
  notes?: string;

  static override getListViewSettings(): ListViewSettings {
    return { columns: ['leftRecord', 'rightRecord', 'confidence', 'status', 'amountDelta', 'dateDeltaDays'] };
  }

  override async beforeSync(): Promise<void> {
    if (this.notInserted) return;
    const stored = await this.fyo.db.get(this.schemaName, this.name as string);
    for (const field of IMMUTABLE_FIELDS) {
      if (!sameImmutableValue(stored[field], (this as Record<string, unknown>)[field])) {
        throw new Error(`DuhGoodsReconciliationMatch: field "${field}" is evidence-immutable and cannot be changed`);
      }
    }
    if (this.status !== 'accepted') return;
    const accepted = await this.fyo.db.getAll(this.schemaName, {
      filters: { status: 'accepted' },
      fields: ['name', 'leftRecord', 'rightRecord'],
    });
    const conflict = accepted.some((row) => row.name !== this.name && (
      row.leftRecord === this.leftRecord || row.rightRecord === this.rightRecord ||
      row.leftRecord === this.rightRecord || row.rightRecord === this.leftRecord
    ));
    if (conflict) throw new Error('Accepted reconciliation conflicts with an existing accepted relationship');
  }
}

function sameImmutableValue(stored: unknown, current: unknown): boolean {
  if (stored == null && current == null) return true;
  if (stored == null || current == null) return false;
  if (typeof stored === 'object' && 'store' in stored && typeof current === 'object' && 'store' in current) return stored.store === current.store;
  if (stored instanceof Date && current instanceof Date) return stored.getTime() === current.getTime();
  return String(stored) === String(current);
}
