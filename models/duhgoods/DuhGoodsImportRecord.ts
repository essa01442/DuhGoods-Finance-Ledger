import { Doc } from 'fyo/model/doc';
import { ListViewSettings } from 'fyo/model/types';
import { Money } from 'pesa';

export class DuhGoodsImportRecord extends Doc {
  importSource?: string;
  sourceType?: string;
  sourceId?: string;
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
  notes?: string;

  static override getListViewSettings(): ListViewSettings {
    return {
      columns: [
        'importSource',
        'sourceType',
        'transactionType',
        'transactionDate',
        'currency',
        'grossAmount',
        'netAmount',
        'status',
      ],
    };
  }
}
