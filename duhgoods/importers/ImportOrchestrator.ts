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
 * Maps (sourceType, sourceId) → evidenceHash so that the same external
 * transaction from the same source namespace is never imported twice,
 * even if the raw JSON happens to match a different source's record.
 * Different sources sharing identical JSON are NOT treated as duplicates.
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

    // Compute the source-file hash from the exact original bytes BEFORE any
    // parsing. This is the provenance hash for the import file itself.
    const sourceHash = computeFileHash(rawBytes);

    let transactions: ImportedTransaction[];
    try {
      const result = this.adapter.parse(rawBytes);
      transactions = result instanceof Promise ? await result : result;
    } catch (err) {
      // Top-level parse failure — entire batch rejected before any records are created.
      return {
        sourceId: '',
        imported: 0,
        skipped: 0,
        errors: [asImportError(err)],
      };
    }

    const importSourceDoc = this.fyo.doc.getNewDoc(
      ModelNameEnum.DuhGoodsImportSource
    );
    importSourceDoc.sourceName = opts.sourceName;
    importSourceDoc.sourceType = this.adapter.sourceType;
    importSourceDoc.importedAt = new Date();
    importSourceDoc.sourceFile = opts.sourceFile ?? '';
    importSourceDoc.sourceHash = sourceHash;
    importSourceDoc.recordCount = transactions.length;
    importSourceDoc.status = 'pending';
    await importSourceDoc.sync();

    const importSourceId = importSourceDoc.name as string;

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

    // Derive the batch status:
    // - 'imported'  : all records processed without errors
    // - 'partial'   : some imported, some errored
    // - 'failed'    : all records errored (or zero imported and errors exist)
    // - 'pending'   : nothing happened (empty batch)
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
    // Identity: (sourceType, sourceId, evidenceHash).
    // We require that the sourceType namespace matches so that two different
    // source systems that happen to produce identical rawData are NOT collapsed.
    const evidenceHash = computeEvidenceHash({
      sourceType: txn.sourceType,
      sourceId: txn.sourceId,
      raw: txn.rawData,
    });

    const existing = await this.fyo.db.getAll(
      ModelNameEnum.DuhGoodsImportRecord,
      {
        fields: ['name'],
        filters: { evidenceHash },
      }
    );

    if (existing.length > 0) {
      return 'skipped';
    }

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
      return {
        sourceId: txn.sourceId,
        message: err instanceof Error ? err.message : String(err),
        raw: txn.rawData,
      };
    }
  }
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
