import { Doc } from 'fyo/model/doc';
import { ListViewSettings } from 'fyo/model/types';

export class DuhGoodsImportSource extends Doc {
  sourceName?: string;
  sourceType?: string;
  importedAt?: Date;
  sourceFile?: string;
  sourceHash?: string;
  recordCount?: number;
  importedCount?: number;
  skippedCount?: number;
  errorCount?: number;
  status?: string;
  errorSummary?: string;

  static override getListViewSettings(): ListViewSettings {
    return {
      columns: [
        'sourceName',
        'sourceType',
        'importedAt',
        'recordCount',
        'importedCount',
        'skippedCount',
        'errorCount',
        'status',
      ],
    };
  }
}
