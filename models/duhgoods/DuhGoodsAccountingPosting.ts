import { Doc } from 'fyo/model/doc';

const IMMUTABLE = [
  'reconciliationMatch',
  'idempotencyKey',
  'postingType',
  'evidenceSnapshot',
  'accountSnapshot',
] as const;

export class DuhGoodsAccountingPosting extends Doc {
  reconciliationMatch?: string;
  idempotencyKey?: string;
  postingType?: string;
  status?: string;
  journalEntry?: string;
  reversalJournalEntry?: string;
  evidenceSnapshot?: string;
  accountSnapshot?: string;
  auditHistory?: string;

  override async beforeSync(): Promise<void> {
    if (this.notInserted) return;
    const stored = await this.fyo.db.get(this.schemaName, this.name as string);
    for (const field of IMMUTABLE) {
      if (
        String(stored[field] ?? '') !==
        String((this as Record<string, unknown>)[field] ?? '')
      ) {
        throw new Error(`DuhGoodsAccountingPosting: "${field}" is immutable`);
      }
      if (stored.journalEntry && stored.journalEntry !== this.journalEntry) {
        throw new Error(
          'DuhGoodsAccountingPosting: "journalEntry" is immutable once set'
        );
      }
    }
    if (stored.status === 'reversed' && this.status !== 'reversed') {
      throw new Error(
        'DuhGoodsAccountingPosting: a reversal cannot be reopened'
      );
    }
  }
}
