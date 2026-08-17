import type { Fyo } from 'fyo';
import { ModelNameEnum } from 'models/types';
import { ImportOrchestrator } from '../importers/ImportOrchestrator';
import { WooCommerceImporter } from '../importers/WooCommerceImporter';
import { PSPExportImporter } from '../importers/PSPExportImporter';
import { BankStatementImporter } from '../importers/BankStatementImporter';
import { DuhGoodsReconciliationService } from '../reconciliation/ReconciliationService';
import type { ImportResult } from '../importers/types';
import { FXService } from '../fx/FXService';

export interface DailyImportSpec {
  woocommerce?: {
    content: Buffer | string;
    namespace: string;
    fileName?: string;
  };
  psp?: {
    content: Buffer | string;
    namespace: string;
    fileName?: string;
    currency?: string;
  };
  bank?: {
    content: Buffer | string;
    namespace: string;
    fileName?: string;
    currency: string;
  };
  fx?: { content: string; fileName?: string };
}

export interface TaggedImportResult extends ImportResult {
  sourceLabel: string;
}

export interface FXImportResult {
  imported: number;
  errors: string[];
}

export interface DailyControlSummary {
  date: Date;
  /** Source IDs created during this run — used to scope reconciliation/posting queries. */
  runSourceIds: string[];
  imported: number;
  skipped: number;
  exceptions: number;
  errors: number;
  matched: number;
  unmatched: number;
  ambiguous: number;
  accepted: number;
  rejected: number;
  posted: number;
  postingExceptions: number;
  vatExceptions: number;
  fxExceptions: number;
  importSources: TaggedImportResult[];
  fxResult: FXImportResult | null;
  balanced: boolean;
  openItems: string[];
}

/**
 * Coordinates the daily file-import workflow.
 *
 * The normal day:
 *   1. Import WooCommerce file → evidence
 *   2. Import PSP export file → evidence
 *   3. Import bank statement file → evidence
 *   4. Optionally import FX rates file → FX evidence
 *   5. Run reconciliation engine → proposals
 *   6. Return control summary for review
 *
 * buildSummary is scoped to the import records belonging to the current run's
 * source IDs. Counts reflect today's batch only, not accumulated historical data.
 *
 * This orchestrator does NOT auto-accept ambiguous matches.
 * Human review is required for any ambiguity.
 */
export class DailyOrchestrator {
  private readonly reconciliation: DuhGoodsReconciliationService;
  private readonly fx: FXService;

  constructor(private readonly fyo: Fyo) {
    this.reconciliation = new DuhGoodsReconciliationService(fyo);
    this.fx = new FXService(fyo);
  }

  async runDailyImport(spec: DailyImportSpec): Promise<DailyControlSummary> {
    const results: TaggedImportResult[] = [];
    const errors: string[] = [];
    let fxResult: FXImportResult | null = null;

    // 1. FX rates first (other imports may need FX)
    if (spec.fx) {
      try {
        const r = await this.fx.importFromJSON(spec.fx.content);
        fxResult = { imported: r.imported ?? 0, errors: r.errors };
        if (r.errors.length > 0) {
          errors.push(...r.errors.map((e) => `FX: ${e}`));
        }
      } catch (e) {
        errors.push(
          `FX import failed: ${e instanceof Error ? e.message : String(e)}`
        );
      }
    }

    // 2. WooCommerce
    if (spec.woocommerce) {
      try {
        const adapter = new WooCommerceImporter();
        const orchestrator = new ImportOrchestrator(this.fyo, adapter);
        const result = await orchestrator.import(spec.woocommerce.content, {
          sourceName: spec.woocommerce.fileName ?? 'WooCommerce export',
          sourceNamespace: spec.woocommerce.namespace,
          sourceFile: spec.woocommerce.fileName,
        });
        results.push({ ...result, sourceLabel: 'woocommerce' });
      } catch (e) {
        errors.push(
          `WooCommerce: ${e instanceof Error ? e.message : String(e)}`
        );
      }
    }

    // 3. PSP export
    if (spec.psp) {
      try {
        const adapter = new PSPExportImporter();
        const orchestrator = new ImportOrchestrator(this.fyo, adapter);
        const result = await orchestrator.import(spec.psp.content, {
          sourceName: spec.psp.fileName ?? 'PSP export',
          sourceNamespace: spec.psp.namespace,
          sourceFile: spec.psp.fileName,
        });
        results.push({ ...result, sourceLabel: 'psp' });
      } catch (e) {
        errors.push(`PSP: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // 4. Bank statement
    if (spec.bank) {
      try {
        const adapter = new BankStatementImporter(spec.bank.currency);
        const orchestrator = new ImportOrchestrator(this.fyo, adapter);
        const result = await orchestrator.import(spec.bank.content, {
          sourceName: spec.bank.fileName ?? 'Bank statement',
          sourceNamespace: spec.bank.namespace,
          sourceFile: spec.bank.fileName,
        });
        results.push({ ...result, sourceLabel: 'bank' });
      } catch (e) {
        errors.push(`Bank: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // 5. Run reconciliation
    try {
      await this.reconciliation.generateProposals();
    } catch (e) {
      errors.push(
        `Reconciliation: ${e instanceof Error ? e.message : String(e)}`
      );
    }

    const runSourceIds = results.map((r) => r.sourceId);
    return this.buildSummary(results, errors, fxResult, runSourceIds);
  }

  /**
   * Builds the daily control summary.
   *
   * When runSourceIds is non-empty, reconciliation/posting/VAT/FX counts are
   * scoped to records that belong to the current run only. When empty (e.g.
   * called externally without run context), the full DB is queried.
   */
  async buildSummary(
    importResults: TaggedImportResult[],
    importErrors: string[] = [],
    fxResult: FXImportResult | null = null,
    runSourceIds: string[] = []
  ): Promise<DailyControlSummary> {
    const totalImported = importResults.reduce((s, r) => s + r.imported, 0);
    const totalSkipped = importResults.reduce((s, r) => s + r.skipped, 0);
    const totalExceptions = importResults.reduce((s, r) => s + r.exceptions, 0);
    const totalErrors =
      importResults.reduce((s, r) => s + r.errors.length, 0) +
      importErrors.length;

    // Determine which import records belong to this run.
    // If runSourceIds is empty we have no run scope — query everything (legacy/manual call).
    const runRecords =
      runSourceIds.length > 0
        ? await this.fyo.db
            .getAll(ModelNameEnum.DuhGoodsImportRecord, {
              filters: { importSource: ['in', runSourceIds] },
              fields: ['name', 'status', 'vatClassification', 'fxReviewNote'],
            })
            .catch(() => [] as Record<string, unknown>[])
        : await this.fyo.db
            .getAll(ModelNameEnum.DuhGoodsImportRecord, {
              fields: ['name', 'status', 'vatClassification', 'fxReviewNote'],
            })
            .catch(() => [] as Record<string, unknown>[]);

    const runRecordNames = new Set(runRecords.map((r) => r.name as string));

    // Reconciliation match counts: scoped to matches where at least one side is
    // a record from this run. When no run scope, count all matches.
    const allMatches = await this.fyo.db.getAll(
      ModelNameEnum.DuhGoodsReconciliationMatch,
      { fields: ['name', 'status', 'confidence', 'leftRecord', 'rightRecord'] }
    );

    const scopedMatches =
      runRecordNames.size > 0
        ? allMatches.filter(
            (m) =>
              runRecordNames.has(m.leftRecord as string) ||
              runRecordNames.has(m.rightRecord as string)
          )
        : allMatches;

    let matched = 0;
    let accepted = 0;
    let rejected = 0;
    let ambiguous = 0;

    for (const m of scopedMatches) {
      if (m.status === 'proposed') matched++;
      if (m.status === 'accepted') accepted++;
      if (m.status === 'rejected') rejected++;
      if (
        m.status === 'proposed' &&
        (m.confidence === 'medium' || m.confidence === 'low')
      ) {
        ambiguous++;
      }
    }

    // Unmatched: run-scoped records still pending/unmatched.
    const unmatched = runRecords.filter(
      (r) => r.status === 'unmatched' || r.status === 'pending'
    ).length;

    // Accounting postings for this run's accepted matches.
    const acceptedMatchNames = scopedMatches
      .filter((m) => m.status === 'accepted')
      .map((m) => m.name as string);

    let posted = 0;
    let postingExceptions = 0;
    if (acceptedMatchNames.length > 0) {
      const postings = await this.fyo.db
        .getAll(ModelNameEnum.DuhGoodsAccountingPosting, {
          filters: { reconciliationMatch: ['in', acceptedMatchNames] },
          fields: ['name', 'status'],
        })
        .catch(() => [] as Record<string, unknown>[]);
      posted = postings.filter((p) => p.status === 'posted').length;
      postingExceptions = postings.filter(
        (p) => p.status === 'exception'
      ).length;
    } else if (runRecordNames.size === 0) {
      // No run scope: count all postings.
      const postings = await this.fyo.db
        .getAll(ModelNameEnum.DuhGoodsAccountingPosting, {
          fields: ['name', 'status'],
        })
        .catch(() => [] as Record<string, unknown>[]);
      posted = postings.filter((p) => p.status === 'posted').length;
      postingExceptions = postings.filter(
        (p) => p.status === 'exception'
      ).length;
    }

    // VAT exceptions: run-scoped records with vatClassification = 'review_required'.
    const vatExceptions = runRecords.filter(
      (r) => r['vatClassification'] === 'review_required'
    ).length;

    // FX exceptions: run-scoped records with fxReviewNote set.
    const fxExceptions = runRecords.filter((r) => !!r['fxReviewNote']).length;

    const openItems: string[] = [];
    if (matched > 0)
      openItems.push(`${matched} طلبات مطابقة معلقة تنتظر المراجعة`);
    if (ambiguous > 0)
      openItems.push(`${ambiguous} طلبات مطابقة غامضة تحتاج مراجعة`);
    if (unmatched > 0) openItems.push(`${unmatched} سجلات غير مطابقة`);
    if (postingExceptions > 0)
      openItems.push(`${postingExceptions} استثناءات ترحيل محاسبي`);
    if (vatExceptions > 0)
      openItems.push(`${vatExceptions} استثناءات ضريبة القيمة المضافة`);
    if (fxExceptions > 0)
      openItems.push(`${fxExceptions} استثناءات أسعار الصرف الأجنبي`);
    if (importErrors.length > 0)
      openItems.push(`${importErrors.length} أخطاء استيراد`);

    const balanced =
      openItems.length === 0 && totalExceptions === 0 && totalErrors === 0;

    return {
      date: new Date(),
      runSourceIds,
      imported: totalImported,
      skipped: totalSkipped,
      exceptions: totalExceptions,
      errors: totalErrors,
      matched,
      unmatched,
      ambiguous,
      accepted,
      rejected,
      posted,
      postingExceptions,
      vatExceptions,
      fxExceptions,
      importSources: importResults,
      fxResult,
      balanced,
      openItems,
    };
  }
}
