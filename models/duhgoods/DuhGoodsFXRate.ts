import { Doc } from 'fyo/model/doc';

const IMMUTABLE_FIELDS = [
  'effectiveDate',
  'baseCurrency',
  'quoteCurrency',
  'rate',
  'sourceDescription',
  'origin',
  'evidenceHash',
  'importSource',
] as const;

export class DuhGoodsFXRate extends Doc {
  effectiveDate?: Date;
  baseCurrency?: string;
  quoteCurrency?: string;
  rate?: number;
  sourceDescription?: string;
  origin?: string;
  evidenceHash?: string;
  importSource?: string;
  notes?: string;

  override async beforeSync(): Promise<void> {
    if (this.notInserted) return;
    const dbRow = await this.fyo.db.get(this.schemaName, this.name as string);
    for (const field of IMMUTABLE_FIELDS) {
      const dbVal = (dbRow as Record<string, unknown>)[field];
      const newVal = this[field as keyof DuhGoodsFXRate];
      if (dbVal !== undefined && dbVal !== null && dbVal !== newVal) {
        throw new Error(
          `DuhGoodsFXRate field "${field}" is immutable and cannot be changed after creation`
        );
      }
    }
  }
}
