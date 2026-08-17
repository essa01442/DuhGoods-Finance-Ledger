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
    const oldHistory = String(stored.auditHistory ?? '');
    const newHistory = String(this.auditHistory ?? '');
    if (oldHistory !== newHistory) {
      const oldEntries: unknown = JSON.parse(oldHistory);
      const newEntries: unknown = JSON.parse(newHistory);
      if (
        !Array.isArray(oldEntries) ||
        !Array.isArray(newEntries) ||
        newEntries.length !== oldEntries.length + 1 ||
        JSON.stringify(newEntries.slice(0, oldEntries.length)) !==
          JSON.stringify(oldEntries)
      ) {
        throw new Error(
          'DuhGoodsAccountingPosting: audit history may only be appended'
        );
      }
    }
  }
}
