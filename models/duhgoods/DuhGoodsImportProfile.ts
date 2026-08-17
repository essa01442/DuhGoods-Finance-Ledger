import { Doc } from 'fyo/model/doc';

export class DuhGoodsImportProfile extends Doc {
  profileName?: string;
  sourceType?: string;
  fileFormat?: string;
  defaultSourceNamespace?: string;
  defaultCurrency?: string;
  columnMappings?: string;
  parserOptions?: string;
  notes?: string;

  getColumnMappings(): Record<string, string> {
    if (!this.columnMappings) return {};
    try {
      return JSON.parse(this.columnMappings) as Record<string, string>;
    } catch {
      return {};
    }
  }

  getParserOptions(): Record<string, unknown> {
    if (!this.parserOptions) return {};
    try {
      return JSON.parse(this.parserOptions) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
}
