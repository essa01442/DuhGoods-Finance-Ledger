import { Fyo, t } from 'fyo';
import { ModelNameEnum } from 'models/types';
import { Report } from 'reports/Report';
import { ColumnField, ReportData } from 'reports/types';
import { Field, FieldTypeEnum } from 'schemas/types';

interface ControlRow {
  label: string;
  value: string | number;
  highlight: boolean;
}

/**
 * DuhGoods Daily Control Report.
 *
 * Shows the operational status of all financial evidence for the current
 * session: imports, reconciliations, postings, and exception counts.
 * The purpose is to give the owner a single view of whether the day
 * is financially reconciled or has outstanding items.
 */
export class DailyControlReport extends Report {
  static get title(): string {
    return t`تقرير التحكم اليومي`;
  }
  static reportName = 'DuhGoodsDailyControl';

  loading = false;
  rows: ControlRow[] = [];

  constructor(fyo: Fyo) {
    super(fyo);
  }

  getFilters(): Field[] {
    return [];
  }

  getColumns(): ColumnField[] {
    return [
      {
        fieldname: 'label',
        label: t`البند`,
        fieldtype: FieldTypeEnum.Data,
        width: 2,
      },
      {
        fieldname: 'value',
        label: t`القيمة`,
        fieldtype: FieldTypeEnum.Data,
        width: 1,
      },
    ];
  }

  async setReportData(): Promise<void> {
    this.loading = true;
    try {
      this.rows = await this.computeRows();
      this.reportData = this.rows.map((r) => ({
        cells: [
          { rawValue: r.label, value: r.label, width: 2 },
          { rawValue: r.value, value: String(r.value), width: 1 },
        ],
        isGroup: false,
      }));
    } finally {
      this.loading = false;
    }
  }

  private async computeRows(): Promise<ControlRow[]> {
    const [records, matches, postings] = await Promise.all([
      this.fyo.db.getAll(ModelNameEnum.DuhGoodsImportRecord, {
        fields: ['name', 'status', 'vatClassification', 'fxReviewNote'],
      }),
      this.fyo.db.getAll(ModelNameEnum.DuhGoodsReconciliationMatch, {
        fields: ['name', 'status', 'confidence'],
      }),
      this.fyo.db.getAll(ModelNameEnum.DuhGoodsAccountingPosting, {
        fields: ['name', 'status'],
      }),
    ]);

    const total = records.length;
    const pending = records.filter((r) => r.status === 'pending').length;
    const reconciled = records.filter((r) => r.status === 'reconciled').length;
    const unmatched = records.filter((r) => r.status === 'unmatched').length;
    const evidenceExceptions = records.filter(
      (r) => r.status === 'exception'
    ).length;

    const proposed = matches.filter((m) => m.status === 'proposed').length;
    const accepted = matches.filter((m) => m.status === 'accepted').length;
    const rejected = matches.filter((m) => m.status === 'rejected').length;
    const ambiguous = matches.filter(
      (m) =>
        m.status === 'proposed' &&
        (m.confidence === 'medium' || m.confidence === 'low')
    ).length;

    const posted = postings.filter((p) => p.status === 'posted').length;
    const postingExceptions = postings.filter(
      (p) => p.status === 'exception'
    ).length;

    const vatExceptions = records.filter(
      (r) =>
        (r as Record<string, unknown>).vatClassification === 'review_required'
    ).length;

    const fxExceptions = records.filter(
      (r) => !!(r as Record<string, unknown>).fxReviewNote
    ).length;

    const importSources = await this.fyo.db.getAll(
      ModelNameEnum.DuhGoodsImportSource,
      {
        fields: [
          'name',
          'status',
          'importedCount',
          'skippedCount',
          'exceptionCount',
        ],
      }
    );

    const rows: ControlRow[] = [
      { label: t`═══ مصادر الاستيراد ═══`, value: '', highlight: false },
      {
        label: t`دفعات الاستيراد`,
        value: importSources.length,
        highlight: false,
      },
      {
        label: t`السجلات المستوردة`,
        value: importSources.reduce(
          (s, r) => s + ((r.importedCount as number) ?? 0),
          0
        ),
        highlight: false,
      },
      {
        label: t`السجلات المتخطاة (مكررة)`,
        value: importSources.reduce(
          (s, r) => s + ((r.skippedCount as number) ?? 0),
          0
        ),
        highlight: false,
      },
      { label: '', value: '', highlight: false },
      { label: t`═══ السجلات ═══`, value: '', highlight: false },
      { label: t`إجمالي سجلات الأدلة`, value: total, highlight: false },
      { label: t`في انتظار المطابقة`, value: pending, highlight: pending > 0 },
      { label: t`تمت المطابقة`, value: reconciled, highlight: false },
      { label: t`غير مطابقة`, value: unmatched, highlight: unmatched > 0 },
      {
        label: t`استثناءات الأدلة`,
        value: evidenceExceptions,
        highlight: evidenceExceptions > 0,
      },
      { label: '', value: '', highlight: false },
      { label: t`═══ التسوية ═══`, value: '', highlight: false },
      { label: t`مقترحات مطابقة`, value: proposed, highlight: false },
      { label: t`مطابقات مقبولة`, value: accepted, highlight: false },
      { label: t`مطابقات مرفوضة`, value: rejected, highlight: false },
      {
        label: t`مطابقات غامضة (تحتاج مراجعة)`,
        value: ambiguous,
        highlight: ambiguous > 0,
      },
      { label: '', value: '', highlight: false },
      { label: t`═══ الترحيل المحاسبي ═══`, value: '', highlight: false },
      { label: t`قيود محاسبية مرحّلة`, value: posted, highlight: false },
      {
        label: t`استثناءات الترحيل`,
        value: postingExceptions,
        highlight: postingExceptions > 0,
      },
      { label: '', value: '', highlight: false },
      {
        label: t`═══ ضريبة القيمة المضافة وأسعار الصرف ═══`,
        value: '',
        highlight: false,
      },
      {
        label: t`استثناءات ضريبة القيمة المضافة`,
        value: vatExceptions,
        highlight: vatExceptions > 0,
      },
      {
        label: t`استثناءات سعر الصرف`,
        value: fxExceptions,
        highlight: fxExceptions > 0,
      },
    ];

    const openCount =
      ambiguous +
      unmatched +
      postingExceptions +
      vatExceptions +
      fxExceptions +
      evidenceExceptions;
    rows.push({ label: '', value: '', highlight: false });
    if (openCount === 0) {
      rows.push({ label: t`اليوم متوازن ✓`, value: t`نعم`, highlight: false });
    } else {
      rows.push({ label: t`بنود معلقة`, value: openCount, highlight: true });
    }

    return rows;
  }
}
