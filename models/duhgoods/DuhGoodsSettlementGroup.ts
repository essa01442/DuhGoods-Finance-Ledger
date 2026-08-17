import { Doc } from 'fyo/model/doc';
import type { ListViewSettings } from 'fyo/model/types';
import type { Money } from 'pesa';

export class DuhGoodsSettlementGroup extends Doc {
  settlementRecord?: string;
  currency?: string;
  memberCount?: number;
  totalMemberNet?: Money;
  settlementNet?: Money;
  delta?: Money;
  confidence?: string;
  status?: string;
  reviewedBy?: string;
  reviewedAt?: Date;
  closedAt?: Date;
  evidenceSnapshot?: string;
  notes?: string;

  static override getListViewSettings(): ListViewSettings {
    return {
      columns: [
        'settlementRecord',
        'currency',
        'memberCount',
        'confidence',
        'status',
        'delta',
      ],
    };
  }
}
