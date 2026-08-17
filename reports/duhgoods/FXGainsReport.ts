import { Fyo, t } from 'fyo';
import { DateTime } from 'luxon';
import { ModelNameEnum } from 'models/types';
import { Report } from 'reports/Report';
import { ColumnField, ReportData } from 'reports/types';
import { Field, FieldTypeEnum } from 'schemas/types';

/**
 * DuhGoods FX Gains/Losses Report.
 *
 * Shows all foreign-currency transactions with their applied FX rates,
 * functional currency amounts, and realized exchange differences.
 * Flags transactions with missing FX evidence requiring human review.
 */
export class FXGainsReport extends Report {
  static get title(): string {
    return t`أرباح وخسائر العملة الأجنبية`;
  }
  static reportName = 'DuhGoodsFXGains';

  loading = false;
  fromDate: string = DateTime.now().startOf('month').toISODate();
  toDate: string = DateTime.now().toISODate();

  constructor(fyo: Fyo) {
    super(fyo);
  }

  getFilters(): Field[] {
    return [
      {
        fieldname: 'fromDate',
        label: t`من تاريخ`,
        fieldtype: FieldTypeEnum.Date,
        required: false,
        section: 'Default',
      } as unknown as Field,
      {
        fieldname: 'toDate',
        label: t`إلى تاريخ`,
        fieldtype: FieldTypeEnum.Date,
        required: false,
        section: 'Default',
      } as unknown as Field,
    ];
  }

  getColumns(): ColumnField[] {
    return [
      {
        fieldname: 'date',
        label: t`التاريخ`,
        fieldtype: FieldTypeEnum.Date,
        width: 1,
      },
      {
        fieldname: 'currency',
        label: t`العملة`,
        fieldtype: FieldTypeEnum.Data,
        width: 1,
      },
      {
        fieldname: 'netAmount',
        label: t`المبلغ بالعملة الأصلية`,
        fieldtype: FieldTypeEnum.Currency,
        width: 1,
      },
      {
        fieldname: 'fxRate',
        label: t`سعر الصرف`,
        fieldtype: FieldTypeEnum.Float,
        width: 1,
      },
      {
        fieldname: 'functionalAmount',
        label: t`المبلغ بالعملة الوظيفية`,
        fieldtype: FieldTypeEnum.Currency,
        width: 1,
      },
      {
        fieldname: 'status',
        label: t`الحالة`,
        fieldtype: FieldTypeEnum.Data,
        width: 1,
      },
    ];
  }

  async setReportData(): Promise<void> {
    this.loading = true;
    try {
      const from = String(this.fromDate) + 'T00:00:00Z';
      const to = String(this.toDate) + 'T23:59:59Z';

      const records = await this.fyo.db.getAll(
        ModelNameEnum.DuhGoodsImportRecord,
        {
          fields: [
            'name',
            'transactionDate',
            'currency',
            'netAmount',
            'fxRate',
            'functionalCurrencyAmount',
            'fxReviewNote',
            'fxRateRef',
          ],
          orderBy: 'transactionDate',
          order: 'asc',
        }
      );

      /* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call */
      const policy: any = await (this.fyo.doc as any)
        .getSingle(ModelNameEnum.DuhGoodsVATPolicy)
        .catch(() => null);
      const functionalCurrency: string =
        (policy?.functionalCurrency as string) ?? 'SAR';
      /* eslint-enable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call */

      const filteredRows = records.filter((r) => {
        if (r.currency === functionalCurrency) return false; // same-currency rows not relevant
        const d = r.transactionDate as Date;
        if (!d) return false;
        const ds = d.toISOString();
        return ds >= from && ds <= to;
      });

      const dataRows: ReportData = filteredRows.map((r) => {
        const hasFX = r.fxRate != null && r.functionalCurrencyAmount != null;
        const hasNote = !!(r as Record<string, unknown>).fxReviewNote;
        const statusLabel = hasNote
          ? t`يحتاج مراجعة`
          : hasFX
          ? t`تم التحويل`
          : t`لا يوجد سعر صرف`;

        return {
          cells: [
            {
              rawValue: r.transactionDate,
              value: (r.transactionDate as Date).toISOString().slice(0, 10),
              width: 1,
            },
            {
              rawValue: r.currency,
              value: r.currency as string,
              width: 1,
            },
            {
              rawValue: r.netAmount,
              value: String(r.netAmount ?? 0),
              width: 1,
            },
            {
              rawValue: r.fxRate ?? '',
              value: r.fxRate != null ? String(r.fxRate) : t`مفقود`,
              width: 1,
            },
            {
              rawValue: r.functionalCurrencyAmount ?? '',
              value:
                r.functionalCurrencyAmount != null
                  ? String(r.functionalCurrencyAmount)
                  : t`مفقود`,
              width: 1,
            },
            {
              rawValue: statusLabel,
              value: statusLabel,
              width: 1,
            },
          ],
          isGroup: false,
        };
      });

      const missingCount = filteredRows.filter((r) => r.fxRate == null).length;
      const headerRows: ReportData = [];
      if (missingCount > 0) {
        headerRows.push({
          cells: [
            {
              rawValue: `⚠ ${missingCount} معاملات تفتقر إلى دليل سعر الصرف`,
              value: `⚠ ${missingCount} معاملات تفتقر إلى دليل سعر الصرف`,
              width: 6,
            },
          ],
          isGroup: true,
        });
      }

      this.reportData = [...headerRows, ...dataRows];
    } finally {
      this.loading = false;
    }
  }
}
