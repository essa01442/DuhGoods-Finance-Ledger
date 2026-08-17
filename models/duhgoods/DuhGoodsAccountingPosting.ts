import { Doc } from 'fyo/model/doc';

const IMMUTABLE = [
  'reconciliationMatch',
  'idempotencyKey',
  'postingType',
  'evidenceSnapshot',
  'accountSnapshot',
] as const;

// Valid status transitions enforced at model level.
const VALID_TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
  reserving: ['reserving', 'posted', 'exception'],
  posted: ['posted', 'reversing'],
  reversing: ['reversing', 'reversed'],
  reversed: ['reversed'],
  exception: ['exception'],
};

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
  exceptionCode?: string;
  exceptionMessage?: string;

  override async beforeSync(): Promise<void> {
    if (this.notInserted) return;
    const stored = await this.fyo.db.get(this.schemaName, this.name as string);

    // Enforce immutable fields.
    for (const field of IMMUTABLE) {
      if (
        String(stored[field] ?? '') !==
        String((this as Record<string, unknown>)[field] ?? '')
      ) {
        throw new Error(`DuhGoodsAccountingPosting: "${field}" is immutable`);
      }
    }

    // journalEntry is immutable once set (check outside the IMMUTABLE loop).
    if (stored.journalEntry && stored.journalEntry !== this.journalEntry) {
      throw new Error(
        'DuhGoodsAccountingPosting: "journalEntry" is immutable once set'
      );
    }

    // Enforce lifecycle transitions.
    const oldStatus = stored.status as string | undefined;
    const newStatus = this.status;
    if (
      oldStatus !== undefined &&
      newStatus !== undefined &&
      oldStatus !== newStatus
    ) {
      const allowed = VALID_TRANSITIONS[oldStatus] ?? [];
      if (!allowed.includes(newStatus)) {
        throw new Error(
          `DuhGoodsAccountingPosting: invalid status transition from "${oldStatus}" to "${newStatus}"`
        );
      }
    }

    // Audit history may only be appended (one entry at a time).
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
