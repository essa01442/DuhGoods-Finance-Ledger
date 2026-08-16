import { Doc } from 'fyo/model/doc';
import { ListViewSettings } from 'fyo/model/types';
import { Money } from 'pesa';

/**
 * Fields that are permanently frozen after initial INSERT.
 *
 * - Provenance/hash fields: identity and audit trail
 * - Financial evidence fields: the raw transaction facts
 *
 * Mutable after insert: status (reconciliation), notes (review).
 */
const IMMUTABLE_FIELDS = [
  // Provenance / audit trail
  'evidenceHash',
  'rawData',
  'sourceType',
  'sourceNamespace',
  'sourceId',
  'identityKey',
  'importSource',
  'priorEvidenceHash',
  'evidenceVersion',
  'rowLocator',
  // Financial evidence
  'transactionType',
  'transactionDate',
  'currency',
  'grossAmount',
  'fees',
  'taxes',
  'netAmount',
] as const;

export class DuhGoodsImportRecord extends Doc {
  importSource?: string;
  sourceType?: string;
  sourceNamespace?: string;
  sourceId?: string;
  identityKey?: string;
  rowLocator?: number;
  transactionType?: string;
  transactionDate?: Date;
  currency?: string;
  grossAmount?: Money;
  fees?: Money;
  taxes?: Money;
  netAmount?: Money;
  status?: string;
  rawData?: string;
  evidenceHash?: string;
  evidenceVersion?: number;
  priorEvidenceHash?: string;
  notes?: string;

  override async beforeSync(): Promise<void> {
    if (this.notInserted) {
      // On insert: enforce evidenceHash uniqueness.
      // The real SQLite UNIQUE INDEX (from createDuhGoodsEvidenceIndex patch)
      // is the atomic guard; this check catches the case before the index
      // exists (e.g. test runs on a freshly-created in-memory DB that has
      // not yet had the patch applied).
      if (this.evidenceHash) {
        const existing = await this.fyo.db.getAll(this.schemaName, {
          filters: { evidenceHash: this.evidenceHash },
          fields: ['name'],
          limit: 1,
        });
        if (existing.length > 0) {
          throw new Error(
            `UNIQUE constraint failed: DuhGoodsImportRecord.evidenceHash`
          );
        }
      }
      return;
    }

    // On update: enforce field-level immutability.
    const dbRow = await this.fyo.db.get(this.schemaName, this.name as string);

    for (const field of IMMUTABLE_FIELDS) {
      const stored = dbRow[field];
      const current = (this as Record<string, unknown>)[field];

      if (!immutableValuesMatch(stored, current)) {
        throw new Error(
          `DuhGoodsImportRecord: field "${field}" is evidence-immutable ` +
            `and cannot be changed after initial import`
        );
      }
    }
  }

  static override getListViewSettings(): ListViewSettings {
    return {
      columns: [
        'importSource',
        'sourceType',
        'sourceNamespace',
        'transactionType',
        'transactionDate',
        'currency',
        'grossAmount',
        'netAmount',
        'status',
        'evidenceVersion',
      ],
    };
  }
}

/**
 * Canonical equality check for immutable fields.
 *
 * Stored values come from SQLite (raw strings/numbers/null).
 * Current values are typed model properties (Money, Date, string, number, null).
 *
 * Rules:
 *   - Both null/undefined → equal (null was stored, null is current — no change).
 *   - One null, other non-null → NOT equal (field was null, now has value or vice versa).
 *   - Money objects: compare pesa `.store` strings (canonical decimal representation).
 *     `fyo.db.get` converts raw DB values through the type converter, so BOTH stored
 *     and current may be Money objects. We compare .store on whichever side is Money.
 *   - Date objects: compare epoch milliseconds; fyo.db.get also converts dates, so
 *     BOTH stored and current may be Date objects.
 *   - Everything else: string coercion comparison.
 */
function immutableValuesMatch(stored: unknown, current: unknown): boolean {
  const storedNull = stored === null || stored === undefined;
  const currentNull = current === null || current === undefined;

  if (storedNull && currentNull) return true;
  if (storedNull || currentNull) return false;

  const storedIsMoney =
    typeof stored === 'object' && stored !== null && 'store' in stored;
  const currentIsMoney =
    typeof current === 'object' && current !== null && 'store' in current;

  if (storedIsMoney && currentIsMoney) {
    return (stored as Money).store === (current as Money).store;
  }
  if (currentIsMoney) {
    return String(stored) === (current as Money).store;
  }
  if (storedIsMoney) {
    return (stored as Money).store === String(current);
  }

  const storedIsDate = stored instanceof Date;
  const currentIsDate = current instanceof Date;

  if (storedIsDate && currentIsDate) {
    return stored.getTime() === current.getTime();
  }
  if (currentIsDate) {
    const d = new Date(String(stored));
    return !isNaN(d.getTime()) && d.getTime() === current.getTime();
  }
  if (storedIsDate) {
    const d = new Date(String(current));
    return !isNaN(d.getTime()) && stored.getTime() === d.getTime();
  }

  return String(stored) === String(current);
}
