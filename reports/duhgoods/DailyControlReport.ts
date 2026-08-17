import { Fyo, t } from 'fyo';
import { Action } from 'fyo/model/types';
import { DateTime } from 'luxon';
import { ModelNameEnum } from 'models/types';
import type { Money } from 'pesa';
import { Report } from 'reports/Report';
import { ColumnField, ReportData } from 'reports/types';
import { Field, FieldTypeEnum } from 'schemas/types';

type Period = 'daily' | 'weekly' | 'monthly';

interface CurrencyTotals {
  currency: string;
  grossAmount: Money;
  fees: Money;
  taxes: Money;
  netAmount: Money;
  count: number;
  unmatchedCount: number;
  unmatchedAmount: Money;
  exceptionsCount: number;
}

/**
 * DuhGoods Daily Control Report.
 *
 * A periodic (daily / weekly / monthly) balance report computed directly
 * from DuhGoodsImportRecord, grouped by currency. Governing rule: every
 * currency has its own, independent totals — there is no combined total
 * across currencies anywhere in this report, and no FX conversion is ever
 * applied.
 */
export class DailyControlReport extends Report {
  static get title(): string {
    return t`تقرير التحكم اليومي`;
  }
  static reportName = 'DuhGoodsDailyControl';

  loading = false;
  period: Period = 'daily';
  date: string = DateTime.now().toISODate();

  constructor(fyo: Fyo) {
    super(fyo);
  }

  setDefaultFilters(): void {
    if (!this.date) {
      this.date = DateTime.now().toISODate();
    }
  }

  getActions(): Action[] {
    return [];
  }

  getFilters(): Field[] {
    return [
      {
        fieldname: 'period',
        label: t`الفترة`,
        fieldtype: FieldTypeEnum.Select,
        options: [
          { value: 'daily', label: t`يومي` },
          { value: 'weekly', label: t`أسبوعي` },
          { value: 'monthly', label: t`شهري` },
        ],
        default: 'daily',
        section: 'Default',
      } as unknown as Field,
      {
        fieldname: 'date',
        label: t`التاريخ`,
        fieldtype: FieldTypeEnum.Date,
        required: false,
        section: 'Default',
      } as unknown as Field,
    ];
  }

  getColumns(): ColumnField[] {
    return [
      {
        fieldname: 'currency',
        label: t`العملة`,
        fieldtype: FieldTypeEnum.Data,
        width: 1,
      },
      {
        fieldname: 'grossAmount',
        label: t`إجمالي المبيعات`,
        fieldtype: FieldTypeEnum.Data,
        width: 1,
      },
      {
        fieldname: 'fees',
        label: t`الرسوم`,
        fieldtype: FieldTypeEnum.Data,
        width: 1,
      },
      {
        fieldname: 'taxes',
        label: t`الضرائب`,
        fieldtype: FieldTypeEnum.Data,
        width: 1,
      },
      {
        fieldname: 'netAmount',
        label: t`الصافي`,
        fieldtype: FieldTypeEnum.Data,
        width: 1,
      },
      {
        fieldname: 'count',
        label: t`عدد العمليات`,
        fieldtype: FieldTypeEnum.Int,
        width: 1,
      },
      {
        fieldname: 'unmatched',
        label: t`غير مطابَق`,
        fieldtype: FieldTypeEnum.Data,
        width: 1,
      },
      {
        fieldname: 'exceptions',
        label: t`الاستثناءات`,
        fieldtype: FieldTypeEnum.Int,
        width: 1,
      },
    ];
  }

  private periodRange(): { from: Date; to: Date } {
    const anchor = DateTime.fromISO(this.date || DateTime.now().toISODate());
    if (this.period === 'weekly') {
      return {
        from: anchor.startOf('week').toJSDate(),
        to: anchor.endOf('week').toJSDate(),
      };
    }
    if (this.period === 'monthly') {
      return {
        from: anchor.startOf('month').toJSDate(),
        to: anchor.endOf('month').toJSDate(),
      };
    }
    return {
      from: anchor.startOf('day').toJSDate(),
      to: anchor.endOf('day').toJSDate(),
    };
  }

  async setReportData(): Promise<void> {
    this.loading = true;
    try {
      const totals = await this.computeCurrencyTotals();
      this.reportData = this.buildReportData(totals);
    } finally {
      this.loading = false;
    }
  }

  private async computeCurrencyTotals(): Promise<CurrencyTotals[]> {
    const { from, to } = this.periodRange();
    const records = await this.fyo.db.getAll(ModelNameEnum.DuhGoodsImportRecord, {
      fields: [
        'name',
        'currency',
        'grossAmount',
        'fees',
        'taxes',
        'netAmount',
        'status',
        'transactionDate',
      ],
    });

    const inPeriod = records.filter((r) => {
      const d = r.transactionDate as Date | undefined;
      if (!d) return false;
      return d >= from && d <= to;
    });

    const byCurrency = new Map<string, CurrencyTotals>();
    for (const record of inPeriod) {
      const currency = String(record.currency ?? '');
      if (!currency) continue;

      let totals = byCurrency.get(currency);
      if (!totals) {
        totals = {
          currency,
          grossAmount: this.fyo.pesa(0),
          fees: this.fyo.pesa(0),
          taxes: this.fyo.pesa(0),
          netAmount: this.fyo.pesa(0),
          count: 0,
          unmatchedCount: 0,
          unmatchedAmount: this.fyo.pesa(0),
          exceptionsCount: 0,
        };
        byCurrency.set(currency, totals);
      }

      const gross = moneyOf(record.grossAmount, this.fyo);
      const fees = moneyOf(record.fees, this.fyo);
      const taxes = moneyOf(record.taxes, this.fyo);
      const net = moneyOf(record.netAmount, this.fyo);

      totals.grossAmount = totals.grossAmount.add(gross);
      totals.fees = totals.fees.add(fees);
      totals.taxes = totals.taxes.add(taxes);
      totals.netAmount = totals.netAmount.add(net);
      totals.count += 1;

      if (record.status === 'unmatched' || record.status === 'pending') {
        totals.unmatchedCount += 1;
        totals.unmatchedAmount = totals.unmatchedAmount.add(gross);
      }
      if (record.status === 'exception') {
        totals.exceptionsCount += 1;
      }
    }

    // Deterministic, currency-code alphabetical order — never influenced by
    // amount magnitude across currencies.
    return [...byCurrency.values()].sort((a, b) =>
      a.currency.localeCompare(b.currency)
    );
  }

  private buildReportData(totals: CurrencyTotals[]): ReportData {
    if (totals.length === 0) {
      return [
        {
          cells: [
            {
              rawValue: t`لا توجد سجلات في هذه الفترة`,
              value: t`لا توجد سجلات في هذه الفترة`,
              width: 8,
            },
          ],
          isGroup: true,
        },
      ];
    }

    const data: ReportData = [];
    for (const c of totals) {
      data.push({
        cells: [
          {
            rawValue: `═══ ${c.currency} ═══`,
            value: `═══ ${c.currency} ═══`,
            width: 8,
          },
        ],
        isGroup: true,
      });
      data.push({
        cells: [
          { rawValue: c.currency, value: c.currency, width: 1 },
          {
            rawValue: c.grossAmount.float,
            value: money(c.grossAmount, c.currency),
            width: 1,
          },
          {
            rawValue: c.fees.float,
            value: money(c.fees, c.currency),
            width: 1,
          },
          {
            rawValue: c.taxes.float,
            value: money(c.taxes, c.currency),
            width: 1,
          },
          {
            rawValue: c.netAmount.float,
            value: money(c.netAmount, c.currency),
            width: 1,
          },
          { rawValue: c.count, value: String(c.count), width: 1 },
          {
            rawValue: c.unmatchedCount,
            value: `${c.unmatchedCount} (${money(c.unmatchedAmount, c.currency)})`,
            width: 1,
          },
          {
            rawValue: c.exceptionsCount,
            value: String(c.exceptionsCount),
            width: 1,
          },
        ],
        isGroup: false,
      });
    }
    return data;
  }
}

function moneyOf(value: unknown, fyo: Fyo): Money {
  if (value && typeof value === 'object' && 'store' in (value as object)) {
    return value as Money;
  }
  return fyo.pesa(String(value ?? 0));
}

function money(amount: Money, currency: string): string {
  return `${amount.float.toFixed(2)} ${currency}`;
}
