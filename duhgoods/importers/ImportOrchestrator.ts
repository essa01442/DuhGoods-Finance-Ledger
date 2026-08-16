import { Fyo } from 'fyo';
import { ModelNameEnum } from 'models/types';
import {
  computeEvidenceHash,
  computeFileHash,
  computeIdentityKey,
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
  /**
   * Logical account / feed identity that scopes all records from this import.
   * Examples: 'bank:SNB:SAR:IBAN1234', 'psp:stripe:live', 'woo:store1'.
   *
   * Must be unique per distinct source account so that the same external
   * transaction reference from two different accounts never collides.
   */
  sourceNamespace: string;
  sourceFile?: string;
}

/**
 * Identity semantics (post-Round-2 redesign):
 *
 *   identityKey (WITH external ref):
 *     SHA-256(sourceType\x00sourceNamespace\x00externalSourceId)
 *
 *   identityKey (WITHOUT external ref — reference-less rows):
 *     SHA-256(sourceType\x00sourceNamespace\x00sourceFileHash\x00rowLocator)
 *
 *   evidenceHash:
 *     SHA-256({ identityKey, raw: rawData })  — canonical-JSON of the pair
 *
 * Four collision classes prevented:
 *   A. Same external ref from different accounts → different sourceNamespace
 *   B. Same ref across different source types → different sourceType
 *   C. Same row position in different import files → different sourceFileHash
 *   D. Changed source data for same identity → different evidenceHash → exception record
 *
 * Changed-evidence versioning (D):
 *   When a record with the same identityKey already exists but with a
 *   different evidenceHash (rawData changed), a new record is created with
 *   evidenceVersion = prior.evidenceVersion + 1 and priorEvidenceHash linking
 *   back to the previous version.  Neither record is modified; the audit trail
 *   is append-only.
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

    const sourceHash = computeFileHash(rawBytes);

    const importSourceDoc = this.fyo.doc.getNewDoc(
      ModelNameEnum.DuhGoodsImportSource
    );
    importSourceDoc.sourceName = opts.sourceName;
    importSourceDoc.sourceType = this.adapter.sourceType;
    importSourceDoc.importedAt = new Date();
    importSourceDoc.sourceFile = opts.sourceFile ?? '';
    importSourceDoc.sourceHash = sourceHash;
    importSourceDoc.recordCount = 0;
    importSourceDoc.importedCount = 0;
    importSourceDoc.skippedCount = 0;
    importSourceDoc.errorCount = 0;
    importSourceDoc.status = 'pending';
    await importSourceDoc.sync();
    const importSourceId = importSourceDoc.name as string;

    let transactions: ImportedTransaction[];
    try {
      const result = this.adapter.parse(rawBytes);
      transactions = result instanceof Promise ? await result : result;
    } catch (err) {
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
      const outcome = await this._importOne(
        txn,
        importSourceId,
        opts.sourceNamespace,
        sourceHash
      );
      if (outcome === 'imported') {
        imported++;
      } else if (outcome === 'skipped') {
        skipped++;
      } else {
        errors.push(outcome);
      }
    }

    let finalStatus: string;
    if (errors.length === 0) {
      finalStatus = 'imported';
    } else if (imported > 0) {
      finalStatus = 'partial';
    } else {
      finalStatus = 'failed';
    }

    importSourceDoc.status = finalStatus;
    importSourceDoc.importedCount = imported;
    importSourceDoc.skippedCount = skipped;
    importSourceDoc.errorCount = errors.length;
    await importSourceDoc.sync();

    return { sourceId: importSourceId, imported, skipped, errors };
  }

  private async _importOne(
    txn: ImportedTransaction,
    importSourceId: string,
    sourceNamespace: string,
    sourceFileHash: string
  ): Promise<'imported' | 'skipped' | ImportError> {
    const rowLocator =
      typeof txn.normalizedMeta?.rowLocator === 'number'
        ? txn.normalizedMeta.rowLocator
        : 0;

    const identityKey = computeIdentityKey({
      sourceType: txn.sourceType,
      sourceNamespace,
      externalSourceId: txn.sourceId,
      sourceFileHash,
      rowLocator,
    });

    const evidenceHash = computeEvidenceHash({
      identityKey,
      raw: txn.rawData,
    });

    try {
      // Check for an existing record with this identityKey.
      const existing = await this.fyo.db.getAll(
        ModelNameEnum.DuhGoodsImportRecord,
        {
          filters: { identityKey },
          fields: ['name', 'evidenceHash', 'evidenceVersion'],
          limit: 1,
          orderBy: 'evidenceVersion',
          order: 'desc',
        }
      );

      if (existing.length > 0) {
        const prior = existing[0];
        if (prior.evidenceHash === evidenceHash) {
          // Identical content already stored — idempotent skip.
          return 'skipped';
        }

        // Same identity, different rawData — append a versioned exception record
        // that links back to the prior version.  The prior record is NOT modified.
        const priorVersion =
          typeof prior.evidenceVersion === 'number' ? prior.evidenceVersion : 1;
        return await this._insertRecord(txn, {
          importSourceId,
          sourceNamespace,
          identityKey,
          evidenceHash,
          rowLocator,
          evidenceVersion: priorVersion + 1,
          priorEvidenceHash: prior.evidenceHash as string,
          status: 'exception',
        });
      }

      return await this._insertRecord(txn, {
        importSourceId,
        sourceNamespace,
        identityKey,
        evidenceHash,
        rowLocator,
        evidenceVersion: 1,
        priorEvidenceHash: '',
        status: 'pending',
      });
    } catch (err) {
      // UNIQUE constraint on evidenceHash — concurrent import of identical data.
      if (isEvidenceHashUniqueError(err)) {
        return 'skipped';
      }
      return {
        sourceId: txn.sourceId,
        message: err instanceof Error ? err.message : String(err),
        raw: txn.rawData,
      };
    }
  }

  private async _insertRecord(
    txn: ImportedTransaction,
    meta: {
      importSourceId: string;
      sourceNamespace: string;
      identityKey: string;
      evidenceHash: string;
      rowLocator: number;
      evidenceVersion: number;
      priorEvidenceHash: string;
      status: string;
    }
  ): Promise<'imported' | ImportError> {
    try {
      const doc = this.fyo.doc.getNewDoc(ModelNameEnum.DuhGoodsImportRecord);
      doc.importSource = meta.importSourceId;
      doc.sourceType = txn.sourceType;
      doc.sourceNamespace = meta.sourceNamespace;
      doc.sourceId = txn.sourceId;
      doc.identityKey = meta.identityKey;
      doc.rowLocator = meta.rowLocator;
      doc.transactionType = txn.transactionType;
      doc.transactionDate = txn.transactionDate;
      doc.currency = txn.currency;
      doc.grossAmount = this.fyo.pesa(txn.grossAmount);
      doc.fees = this.fyo.pesa(txn.fees);
      doc.taxes = this.fyo.pesa(txn.taxes);
      doc.netAmount = this.fyo.pesa(txn.netAmount);
      doc.status = meta.status;
      doc.rawData = JSON.stringify(txn.rawData);
      doc.evidenceHash = meta.evidenceHash;
      doc.evidenceVersion = meta.evidenceVersion;
      doc.priorEvidenceHash = meta.priorEvidenceHash;
      await doc.sync();
      return 'imported';
    } catch (err) {
      if (isEvidenceHashUniqueError(err)) {
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

function isEvidenceHashUniqueError(err: unknown): boolean {
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
