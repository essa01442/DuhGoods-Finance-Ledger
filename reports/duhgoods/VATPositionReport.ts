import { Fyo, t } from 'fyo';
import { DateTime } from 'luxon';
import { Report } from 'reports/Report';
import { ColumnField, ReportData } from 'reports/types';
import { Field, FieldTypeEnum } from 'schemas/types';
import { VATEngine } from 'duhgoods/vat/VATEngine';

/**
 * DuhGoods VAT Position Report.
 *
 * Shows output VAT, input VAT, and net VAT payable for a given period.
 * Drills down to individual transaction evidence.
 * Flags records that require human VAT classification review.
 */
export class VATPositionReport extends Report {
  static get title(): string {
    return t`موقف ضريبة القيمة المضافة`;
  }
  static reportName = 'DuhGoodsVATPosition';

  loading = false;
  fromDate: string = DateTime.now().startOf('quarter').toISODate();
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
        fieldname: 'transactionType',
        label: t`نوع العملية`,
        fieldtype: FieldTypeEnum.Data,
        width: 1,
      },
      {
        fieldname: 'classification',
        label: t`التصنيف الضريبي`,
        fieldtype: FieldTypeEnum.Data,
        width: 1,
      },
      {
        fieldname: 'vatAmount',
        label: t`مبلغ الضريبة`,
        fieldtype: FieldTypeEnum.Currency,
        width: 1,
      },
      {
        fieldname: 'recordName',
        label: t`رقم السجل`,
        fieldtype: FieldTypeEnum.Data,
        width: 1,
      },
    ];
  }

  async setReportData(): Promise<void> {
    this.loading = true;
    try {
      const engine = new VATEngine(this.fyo);
      const from = new Date(String(this.fromDate) + 'T00:00:00Z');
      const to = new Date(String(this.toDate) + 'T23:59:59Z');
      const summary = await engine.getPeriodSummary(from, to);

      const headerRows: ReportData = [
        {
          cells: [
            {
              rawValue: t`إجمالي ضريبة المبيعات (مخرجات)`,
              value: t`إجمالي ضريبة المبيعات (مخرجات)`,
              width: 3,
            },
            {
              rawValue: summary.outputVAT.float,
              value: summary.outputVAT.store,
              width: 1,
            },
            { rawValue: '', value: '', width: 1 },
          ],
          isGroup: true,
        },
        {
          cells: [
            {
              rawValue: t`إجمالي ضريبة المشتريات (مدخلات)`,
              value: t`إجمالي ضريبة المشتريات (مدخلات)`,
              width: 3,
            },
            {
              rawValue: summary.inputVAT.float,
              value: summary.inputVAT.store,
              width: 1,
            },
            { rawValue: '', value: '', width: 1 },
          ],
          isGroup: true,
        },
        {
          cells: [
            {
              rawValue: t`صافي الضريبة المستحقة`,
              value: t`صافي الضريبة المستحقة`,
              width: 3,
            },
            {
              rawValue: summary.netVATPayable.float,
              value: summary.netVATPayable.store,
              width: 1,
            },
            { rawValue: '', value: '', width: 1 },
          ],
          isGroup: true,
        },
      ];

      const lineRows: ReportData = summary.lineItems.map((item) => ({
        cells: [
          {
            rawValue: item.transactionDate,
            value: item.transactionDate.toISOString().slice(0, 10),
            width: 1,
          },
          {
            rawValue: item.transactionType,
            value: item.transactionType,
            width: 1,
          },
          {
            rawValue: item.vatClassification,
            value: item.vatClassification,
            width: 1,
          },
          {
            rawValue: item.vatAmount.float,
            value: item.vatAmount.store,
            width: 1,
          },
          {
            rawValue: item.recordName,
            value: item.recordName,
            width: 1,
          },
        ],
        isGroup: false,
      }));

      this.reportData = [...headerRows, ...lineRows];

      if (summary.reviewRequired > 0) {
        this.reportData.push({
          cells: [
            {
              rawValue: `⚠ ${summary.reviewRequired} سجلات تحتاج تصنيفاً ضريبياً`,
              value: `⚠ ${summary.reviewRequired} سجلات تحتاج تصنيفاً ضريبياً`,
              width: 5,
            },
          ],
          isGroup: true,
        });
      }
    } finally {
      this.loading = false;
    }
  }
}
