import { Doc } from 'fyo/model/doc';
import { ListViewSettings } from 'fyo/model/types';
import { Money } from 'pesa';

const IMMUTABLE_FIELDS = [
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
      // On insert: enforce evidenceHash uniqueness (Frappe Books does not
      // create SQL UNIQUE indexes from schema metadata).
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
      if (stored === undefined || stored === null) continue;

      const current = (this as Record<string, unknown>)[field];
      if (String(stored) !== String(current ?? '')) {
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
