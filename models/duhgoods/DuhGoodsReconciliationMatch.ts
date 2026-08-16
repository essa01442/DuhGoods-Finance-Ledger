import { Doc } from 'fyo/model/doc';
import { ListViewSettings } from 'fyo/model/types';
import { Money } from 'pesa';

export class DuhGoodsReconciliationMatch extends Doc {
  importRecord?: string;
  matchType?: string;
  matchedDocument?: string;
  matchedDocumentType?: string;
  confidence?: string;
  status?: string;
  matchedAt?: Date;
  amountDelta?: Money;
  notes?: string;

  static override getListViewSettings(): ListViewSettings {
    return {
      columns: [
        'importRecord',
        'matchType',
        'matchedDocument',
        'confidence',
        'status',
        'amountDelta',
      ],
    };
  }
}
