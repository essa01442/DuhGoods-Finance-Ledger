import { BalanceSheet } from './BalanceSheet/BalanceSheet';
import { GeneralLedger } from './GeneralLedger/GeneralLedger';
import { GSTR1 } from './GoodsAndServiceTax/GSTR1';
import { GSTR2 } from './GoodsAndServiceTax/GSTR2';
import { ProfitAndLoss } from './ProfitAndLoss/ProfitAndLoss';
import { TrialBalance } from './TrialBalance/TrialBalance';
import { StockBalance } from './inventory/StockBalance';
import { StockLedger } from './inventory/StockLedger';
import { DailyControlReport } from './duhgoods/DailyControlReport';
import { VATPositionReport } from './duhgoods/VATPositionReport';
import { FXGainsReport } from './duhgoods/FXGainsReport';

export const reports = {
  GeneralLedger,
  ProfitAndLoss,
  BalanceSheet,
  TrialBalance,
  GSTR1,
  GSTR2,
  StockLedger,
  StockBalance,
  DuhGoodsDailyControl: DailyControlReport,
  DuhGoodsVATPosition: VATPositionReport,
  DuhGoodsFXGains: FXGainsReport,
} as const;
