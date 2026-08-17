import { Doc } from 'fyo/model/doc';

export class DuhGoodsVATPolicy extends Doc {
  enabled?: number;
  standardRate?: number;
  functionalCurrency?: string;
  defaultSalesClassification?: string;
  defaultFeeClassification?: string;
  defaultShippingClassification?: string;
  vatRegistrationNumber?: string;
  vatPeriodType?: string;
  notes?: string;
}
