import { Fyo } from 'fyo';
import { ModelNameEnum } from 'models/types';
import {
  computeEvidenceHash,
  computeFileHash,
} from '../evidence/EvidenceManager';
import {
  ImportAdapter,
  ImportError,
  ImportResult,
  ImportValidationError,
  ImportedTransaction,
} from './types';

export interface OrchestratorOptions {
  sourceName: string;
  sourceFile?: string;
}

/**
 * Identity semantics:
 *   source namespace : sourceType (woocommerce / bank_statement / psp_export / manual)
 *   external ID      : sourceId (the source system's own transaction identifier)
 *   evidence hash    : SHA-256(sourceType + sourceId + canonical(rawData))
 *
 * Two records with the same (sourceType, sourceId) but different rawData produce
 * different evidence hashes — the earlier record is preserved and the new one is
 * skipped. Changed source data for the same external ID never silently overwrites
 * prior evidence; it simply becomes a no-op import (skipped with the same hash
 * already in the database) or a new record if the hash differs.
 *
 * Database-level uniqueness on evidenceHash (UNIQUE constraint on the
 * DuhGoodsImportRecord.evidenceHash column) makes idempotency atomic: concurrent
 * imports of the same record race to insert, and the loser gets a UNIQUE constraint
 * error, which is caught and treated as 'skipped'. A query-before-insert check
 * is insufficient because two imports arriving simultaneously would both pass the
 * read check and then one would fail at insert time.
 */
export class ImportOrchestrator {
  private fyo: Fyo;
  private adapter: ImportAdapter;

  constructor(fyo: Fyo, adapter: ImportAdapter) {
    this.fyo = fyo;
    this.adapter = adapter;
  }

  async import(
    input: string | Buffer,
    opts: OrchestratorOptions
  ): Promise<ImportResult> {
    const rawBytes =
      typeof input === 'string' ? Buffer.from(input, 'utf8') : input;

    // Compute source-file hash from exact original bytes BEFORE any parsing.
    const sourceHash = computeFileHash(rawBytes);

    // Create ImportSource record BEFORE parsing so that even a parse failure
    // leaves an auditable trail with source hash, type, file name, and timestamp.
    const importSourceDoc = this.fyo.doc.getNewDoc(
      ModelNameEnum.DuhGoodsImportSource
    );
    importSourceDoc.sourceName = opts.sourceName;
    importSourceDoc.sourceType = this.adapter.sourceType;
    importSourceDoc.importedAt = new Date();
    importSourceDoc.sourceFile = opts.sourceFile ?? '';
    importSourceDoc.sourceHash = sourceHash;
    importSourceDoc.recordCount = 0;
    importSourceDoc.status = 'pending';
    await importSourceDoc.sync();
    const importSourceId = importSourceDoc.name as string;

    let transactions: ImportedTransaction[];
    try {
      const result = this.adapter.parse(rawBytes);
      transactions = result instanceof Promise ? await result : result;
    } catch (err) {
      // Parse failure: update ImportSource to 'failed' so the attempt is auditable.
      importSourceDoc.status = 'failed';
      importSourceDoc.errorSummary =
        err instanceof Error ? err.message : String(err);
      importSourceDoc.recordCount = 0;
      await importSourceDoc.sync();
      return {
        sourceId: importSourceId,
        imported: 0,
        skipped: 0,
        errors: [asImportError(err)],
      };
    }

    importSourceDoc.recordCount = transactions.length;
    await importSourceDoc.sync();

    const errors: ImportError[] = [];
    let imported = 0;
    let skipped = 0;

    for (const txn of transactions) {
      const outcome = await this._importOne(txn, importSourceId);
      if (outcome === 'imported') {
        imported++;
      } else if (outcome === 'skipped') {
        skipped++;
      } else {
        errors.push(outcome);
      }
    }

    // Batch status:
    //   'imported' — all records processed without errors
    //   'partial'  — some imported, some errored
    //   'failed'   — all errored (or zero imported with errors)
    let finalStatus: string;
    if (errors.length === 0) {
      finalStatus = 'imported';
    } else if (imported > 0) {
      finalStatus = 'partial';
    } else {
      finalStatus = 'failed';
    }

    importSourceDoc.status = finalStatus;
    await importSourceDoc.sync();

    return { sourceId: importSourceId, imported, skipped, errors };
  }

  private async _importOne(
    txn: ImportedTransaction,
    importSourceId: string
  ): Promise<'imported' | 'skipped' | ImportError> {
    const evidenceHash = computeEvidenceHash({
      sourceType: txn.sourceType,
      sourceId: txn.sourceId,
      raw: txn.rawData,
    });

    try {
      const doc = this.fyo.doc.getNewDoc(ModelNameEnum.DuhGoodsImportRecord);
      doc.importSource = importSourceId;
      doc.sourceType = txn.sourceType;
      doc.sourceId = txn.sourceId;
      doc.transactionType = txn.transactionType;
      doc.transactionDate = txn.transactionDate;
      doc.currency = txn.currency;
      doc.grossAmount = this.fyo.pesa(txn.grossAmount);
      doc.fees = this.fyo.pesa(txn.fees);
      doc.taxes = this.fyo.pesa(txn.taxes);
      doc.netAmount = this.fyo.pesa(txn.netAmount);
      doc.status = 'pending';
      doc.rawData = JSON.stringify(txn.rawData);
      doc.evidenceHash = evidenceHash;
      await doc.sync();
      return 'imported';
    } catch (err) {
      // UNIQUE constraint violation means a duplicate evidence hash already
      // exists — treat as idempotent skip rather than an error.
      if (isUniqueConstraintError(err)) {
        return 'skipped';
      }
      return {
        sourceId: txn.sourceId,
        message: err instanceof Error ? err.message : String(err),
        raw: txn.rawData,
      };
    }
  }
}

function isUniqueConstraintError(err: unknown): boolean {
  // Match only the DuhGoodsImportRecord.evidenceHash UNIQUE constraint, not any
  // unrelated UNIQUE violation on other columns or tables.
  return (
    err instanceof Error &&
    /UNIQUE constraint failed:\s*DuhGoodsImportRecord\.evidenceHash/i.test(
      err.message
    )
  );
}

function asImportError(err: unknown): ImportError {
  if (err instanceof ImportValidationError) {
    return {
      sourceId: err.sourceId,
      message: err.message,
      raw: err.raw,
    };
  }
  return { message: err instanceof Error ? err.message : String(err) };
}
