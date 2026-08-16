import { Doc } from 'fyo/model/doc';
import { ListViewSettings } from 'fyo/model/types';
import { Money } from 'pesa';

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
