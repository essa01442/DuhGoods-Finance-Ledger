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
  woocommerce?: { content: Buffer | string; namespace: string; fileName?: string };
  psp?: { content: Buffer | string; namespace: string; fileName?: string; currency?: string };
  bank?: { content: Buffer | string; namespace: string; fileName?: string; currency: string };
  fx?: { content: string; fileName?: string };
}

export interface DailyControlSummary {
  date: Date;
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
  importSources: ImportResult[];
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
    const results: ImportResult[] = [];
    const errors: string[] = [];

    // 1. FX rates first (other imports may need FX)
    if (spec.fx) {
      try {
        const fxResult = await this.fx.importFromJSON(spec.fx.content);
        if (fxResult.errors.length > 0) {
          errors.push(...fxResult.errors.map((e) => `FX: ${e}`));
        }
      } catch (e) {
        errors.push(`FX import failed: ${e instanceof Error ? e.message : String(e)}`);
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
        results.push(result);
      } catch (e) {
        errors.push(`WooCommerce: ${e instanceof Error ? e.message : String(e)}`);
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
        results.push(result);
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
        results.push(result);
      } catch (e) {
        errors.push(`Bank: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // 5. Run reconciliation
    try {
      await this.reconciliation.generateProposals();
    } catch (e) {
      errors.push(`Reconciliation: ${e instanceof Error ? e.message : String(e)}`);
    }

    return this.buildSummary(results, errors);
  }

  async buildSummary(
    importResults: ImportResult[],
    importErrors: string[] = []
  ): Promise<DailyControlSummary> {
    const totalImported = importResults.reduce((s, r) => s + r.imported, 0);
    const totalSkipped = importResults.reduce((s, r) => s + r.skipped, 0);
    const totalExceptions = importResults.reduce((s, r) => s + r.exceptions, 0);
    const totalErrors = importResults.reduce((s, r) => s + r.errors.length, 0) + importErrors.length;

    // Count reconciliation proposals by status
    const allMatches = await this.fyo.db.getAll(
      ModelNameEnum.DuhGoodsReconciliationMatch,
      {
        fields: ['name', 'status', 'confidence'],
      }
    );

    let matched = 0;
    let accepted = 0;
    let rejected = 0;
    let ambiguous = 0;

    for (const m of allMatches) {
      if (m.status === 'proposed') matched++;
      if (m.status === 'accepted') accepted++;
      if (m.status === 'rejected') rejected++;
    }

    // Count ambiguous (medium confidence or lower among proposed)
    for (const m of allMatches) {
      if (
        m.status === 'proposed' &&
        (m.confidence === 'medium' || m.confidence === 'low')
      ) {
        ambiguous++;
      }
    }

    // Count unmatched records
    const allRecords = await this.fyo.db.getAll(
      ModelNameEnum.DuhGoodsImportRecord,
      {
        fields: ['name', 'status'],
      }
    );
    const unmatched = allRecords.filter((r) => r.status === 'unmatched' || r.status === 'pending').length;

    // Count accounting postings
    const postings = await this.fyo.db.getAll(
      ModelNameEnum.DuhGoodsAccountingPosting,
      { fields: ['name', 'status'] }
    );
    const posted = postings.filter((p) => p.status === 'posted').length;
    const postingExceptions = postings.filter((p) => p.status === 'exception').length;

    // VAT exceptions: records with vatClassification = 'review_required'
    const vatExceptions = allRecords.filter(
      (r) => (r as Record<string, unknown>).vatClassification === 'review_required'
    ).length;

    // FX exceptions: records with fxReviewNote
    const fxExceptionRows = await this.fyo.db.getAll(
      ModelNameEnum.DuhGoodsImportRecord,
      {
        filters: { fxReviewNote: ['!=', ''] },
        fields: ['name'],
      }
    ).catch(() => []);
    const fxExceptions = fxExceptionRows.length;

    const openItems: string[] = [];
    if (ambiguous > 0) openItems.push(`${ambiguous} طلبات مطابقة غامضة تحتاج مراجعة`);
    if (unmatched > 0) openItems.push(`${unmatched} سجلات غير مطابقة`);
    if (postingExceptions > 0) openItems.push(`${postingExceptions} استثناءات ترحيل محاسبي`);
    if (vatExceptions > 0) openItems.push(`${vatExceptions} استثناءات ضريبة القيمة المضافة`);
    if (fxExceptions > 0) openItems.push(`${fxExceptions} استثناءات أسعار الصرف الأجنبي`);
    if (importErrors.length > 0) openItems.push(`${importErrors.length} أخطاء استيراد`);

    const balanced =
      openItems.length === 0 &&
      totalExceptions === 0 &&
      totalErrors === 0;

    return {
      date: new Date(),
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
      balanced,
      openItems,
    };
  }
}
