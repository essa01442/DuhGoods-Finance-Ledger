import { Doc } from 'fyo/model/doc';
import { ListViewSettings } from 'fyo/model/types';

const IMMUTABLE_FIELDS = [
  'sourceName',
  'sourceNamespace',
  'sourceType',
  'importedAt',
  'sourceFile',
  'sourceHash',
] as const;

export class DuhGoodsImportSource extends Doc {
  sourceName?: string;
  sourceNamespace?: string;
  sourceType?: string;
  importedAt?: Date;
  sourceFile?: string;
  sourceHash?: string;
  recordCount?: number;
  importedCount?: number;
  skippedCount?: number;
  exceptionCount?: number;
  errorCount?: number;
  status?: string;
  errorSummary?: string;

  override async beforeSync(): Promise<void> {
    if (this.notInserted) {
      return;
    }

    const dbRow = await this.fyo.db.get(this.schemaName, this.name as string);

    for (const field of IMMUTABLE_FIELDS) {
      const stored = dbRow[field];
      const current = (this as Record<string, unknown>)[field];

      if (!sourceImmutableValuesMatch(stored, current)) {
        throw new Error(
          `DuhGoodsImportSource: field "${field}" is provenance-immutable ` +
            `and cannot be changed after initial import`
        );
      }
    }
  }

  static override getListViewSettings(): ListViewSettings {
    return {
      columns: [
        'sourceName',
        'sourceNamespace',
        'sourceType',
        'importedAt',
        'recordCount',
        'importedCount',
        'skippedCount',
        'exceptionCount',
        'errorCount',
        'status',
      ],
    };
  }
}

/**
 * Canonical equality check for provenance-immutable fields on DuhGoodsImportSource.
 *
 * fyo.db.get() runs stored values through the type converter, so Date fields
 * (importedAt) may come back as Date objects from both stored and current.
 */
function sourceImmutableValuesMatch(
  stored: unknown,
  current: unknown
): boolean {
  const storedNull = stored === null || stored === undefined;
  const currentNull = current === null || current === undefined;

  if (storedNull && currentNull) return true;
  if (storedNull || currentNull) return false;

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
