import { Doc } from 'fyo/model/doc';
import { ListViewSettings } from 'fyo/model/types';

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
