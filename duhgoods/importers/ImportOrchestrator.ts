import { Fyo } from 'fyo';
import { ModelNameEnum } from 'models/types';
import { computeEvidenceHash } from '../evidence/EvidenceManager';
import {
  ImportAdapter,
  ImportError,
  ImportResult,
  ImportedTransaction,
} from './types';

export interface OrchestratorOptions {
  sourceName: string;
  sourceFile?: string;
  sourceHash?: string;
}

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
    const transactions = await this.adapter.parse(input);

    const importSourceDoc = this.fyo.doc.getNewDoc(
      ModelNameEnum.DuhGoodsImportSource
    );
    importSourceDoc.sourceName = opts.sourceName;
    importSourceDoc.sourceType = this.adapter.sourceType;
    importSourceDoc.importedAt = new Date();
    importSourceDoc.sourceFile = opts.sourceFile ?? '';
    importSourceDoc.sourceHash = opts.sourceHash ?? '';
    importSourceDoc.recordCount = transactions.length;
    importSourceDoc.status = 'pending';
    await importSourceDoc.sync();

    const importSourceId = importSourceDoc.name as string;

    const errors: ImportError[] = [];
    let imported = 0;
    let skipped = 0;

    for (const txn of transactions) {
      const result = await this._importOne(txn, importSourceId);
      if (result === 'imported') {
        imported++;
      } else if (result === 'skipped') {
        skipped++;
      } else {
        errors.push(result);
      }
    }

    const finalStatus = errors.length > 0 ? 'error' : 'imported';
    importSourceDoc.status = finalStatus;
    await importSourceDoc.sync();

    return { sourceId: importSourceId, imported, skipped, errors };
  }

  private async _importOne(
    txn: ImportedTransaction,
    importSourceId: string
  ): Promise<'imported' | 'skipped' | ImportError> {
    const evidenceHash = computeEvidenceHash(txn.rawData);

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
