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

export interface InsertRecordMeta {
  importSourceId: string;
  sourceNamespace: string;
  identityKey: string;
  evidenceHash: string;
  rowLocator: number;
  evidenceVersion: number;
  priorEvidenceHash: string;
  status: string;
}

export interface OrchestratorOptions {
  sourceName: string;
  /**
   * Logical account / feed identity that scopes all records from this import.
   * Examples: 'bank:SNB:SAR:IBAN1234', 'psp:stripe:live', 'woo:store1'.
   *
   * Required, non-empty after whitespace trimming. Validated before any
   * database record is written so failed-validation attempts leave no trace.
   */
  sourceNamespace: string;
  sourceFile?: string;
}

/**
 * Outcome of processing a single imported transaction.
 *
 *   'imported'  — first-time evidence stored successfully.
 *   'skipped'   — identical evidence already exists (idempotent re-import).
 *   'exception' — same identity, different rawData (changed evidence chain).
 *   ImportError — parse/validation/DB error; record the failure without aborting the batch.
 */
type OneOutcome = 'imported' | 'skipped' | 'exception' | ImportError;

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
    // Validate sourceNamespace before creating any DB record.
    const sourceNamespace = validateSourceNamespace(opts.sourceNamespace);

    const rawBytes =
      typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
    const sourceHash = computeFileHash(rawBytes);

    const importSourceDoc = this.fyo.doc.getNewDoc(
      ModelNameEnum.DuhGoodsImportSource
    );
    importSourceDoc.sourceName = opts.sourceName;
    importSourceDoc.sourceNamespace = sourceNamespace;
    importSourceDoc.sourceType = this.adapter.sourceType;
    importSourceDoc.importedAt = new Date();
    importSourceDoc.sourceFile = opts.sourceFile ?? '';
    importSourceDoc.sourceHash = sourceHash;
    importSourceDoc.recordCount = 0;
    importSourceDoc.importedCount = 0;
    importSourceDoc.skippedCount = 0;
    importSourceDoc.exceptionCount = 0;
    importSourceDoc.errorCount = 0;
    importSourceDoc.status = 'pending';
    await importSourceDoc.sync();
    const importSourceId = importSourceDoc.name as string;

    let transactions: ImportedTransaction[];
    try {
      const result = this.adapter.parse(rawBytes);
      transactions = result instanceof Promise ? await result : result;
    } catch (err) {
      // Parse failure: audit the attempt; errorCount reflects the failed batch.
      importSourceDoc.status = 'failed';
      importSourceDoc.errorSummary =
        err instanceof Error ? err.message : String(err);
      importSourceDoc.recordCount = 0;
      importSourceDoc.errorCount = 1;
      await importSourceDoc.sync();
      return {
        sourceId: importSourceId,
        imported: 0,
        skipped: 0,
        exceptions: 0,
        errors: [asImportError(err)],
      };
    }

    importSourceDoc.recordCount = transactions.length;
    await importSourceDoc.sync();

    const errors: ImportError[] = [];
    let imported = 0;
    let skipped = 0;
    let exceptions = 0;

    for (const txn of transactions) {
      const outcome = await this._importOne(
        txn,
        importSourceId,
        sourceNamespace,
        sourceHash
      );
      if (outcome === 'imported') {
        imported++;
      } else if (outcome === 'skipped') {
        skipped++;
      } else if (outcome === 'exception') {
        exceptions++;
      } else {
        errors.push(outcome);
      }
    }

    // Batch status semantics:
    //   'imported' — processed without errors or exceptions (skips are fine)
    //   'partial'  — has exceptions and/or errors alongside some imported/skipped
    //   'failed'   — all records errored (zero imported, zero exceptions)
    let finalStatus: string;
    if (errors.length === 0 && exceptions === 0) {
      finalStatus = 'imported';
    } else if (imported > 0 || skipped > 0 || exceptions > 0) {
      finalStatus = 'partial';
    } else {
      finalStatus = 'failed';
    }

    importSourceDoc.status = finalStatus;
    importSourceDoc.importedCount = imported;
    importSourceDoc.skippedCount = skipped;
    importSourceDoc.exceptionCount = exceptions;
    importSourceDoc.errorCount = errors.length;
    await importSourceDoc.sync();

    return { sourceId: importSourceId, imported, skipped, exceptions, errors };
  }

  private async _importOne(
    txn: ImportedTransaction,
    importSourceId: string,
    sourceNamespace: string,
    sourceFileHash: string
  ): Promise<OneOutcome> {
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

        // Same identity, different rawData — append a versioned exception
        // record linking back to the prior version.  Prior record is untouched.
        // Retry up to MAX_VERSION_RETRIES times if a concurrent import claims
        // the same version slot between our read and our write.
        const MAX_VERSION_RETRIES = 3;
        let latestPriorVersion =
          typeof prior.evidenceVersion === 'number' ? prior.evidenceVersion : 1;
        let latestPriorHash = prior.evidenceHash as string;

        for (let attempt = 0; attempt <= MAX_VERSION_RETRIES; attempt++) {
          const insertResult = await this._insertRecord(txn, {
            importSourceId,
            sourceNamespace,
            identityKey,
            evidenceHash,
            rowLocator,
            evidenceVersion: latestPriorVersion + 1,
            priorEvidenceHash: latestPriorHash,
            status: 'exception',
          });

          if (insertResult === 'imported') return 'exception';
          if (insertResult === 'skipped') return 'skipped';
          if (insertResult !== 'version_collision') return insertResult;

          // Another process claimed that version slot. Re-read the latest.
          const raceLatest = await this.fyo.db.getAll(
            ModelNameEnum.DuhGoodsImportRecord,
            {
              filters: { identityKey },
              fields: ['name', 'evidenceHash', 'evidenceVersion'],
              limit: 1,
              orderBy: 'evidenceVersion',
              order: 'desc',
            }
          );
          if (raceLatest.length === 0) break;
          const newest = raceLatest[0];
          if (newest.evidenceHash === evidenceHash) {
            // Concurrent winner stored identical evidence — idempotent skip.
            return 'skipped';
          }
          latestPriorVersion =
            typeof newest.evidenceVersion === 'number'
              ? newest.evidenceVersion
              : latestPriorVersion + 1;
          latestPriorHash = newest.evidenceHash as string;
        }

        return {
          sourceId: txn.sourceId,
          message: `Evidence version race unresolved after ${
            MAX_VERSION_RETRIES + 1
          } attempts for identityKey "${identityKey}"`,
          raw: txn.rawData,
        };
      }

      const firstInsert = await this._insertRecord(txn, {
        importSourceId,
        sourceNamespace,
        identityKey,
        evidenceHash,
        rowLocator,
        evidenceVersion: 1,
        priorEvidenceHash: '',
        status: 'pending',
      });
      // Concurrent first-insert race: another process already claimed version 1.
      // Treat as idempotent skip — both processes imported the same transaction.
      if (firstInsert === 'version_collision') return 'skipped';
      return firstInsert;
    } catch (err) {
      // Real SQLite UNIQUE constraint on evidenceHash — concurrent import.
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

  protected async _insertRecord(
    txn: ImportedTransaction,
    meta: InsertRecordMeta
  ): Promise<'imported' | 'skipped' | 'version_collision' | ImportError> {
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
        return 'skipped'; // concurrent evidenceHash race; caller treats as skip
      }
      if (isIdentityVersionUniqueError(err)) {
        return 'version_collision'; // concurrent version slot race; caller retries
      }
      return {
        sourceId: txn.sourceId,
        message: err instanceof Error ? err.message : String(err),
        raw: txn.rawData,
      };
    }
  }
}

function validateSourceNamespace(raw: unknown): string {
  if (raw === undefined || raw === null) {
    throw new ImportValidationError(
      ['sourceNamespace is required'],
      undefined,
      {}
    );
  }
  const ns = String(raw).trim();
  if (ns.length === 0) {
    throw new ImportValidationError(
      ['sourceNamespace must not be blank or whitespace-only'],
      undefined,
      {}
    );
  }
  return ns;
}

function isEvidenceHashUniqueError(err: unknown): boolean {
  return (
    err instanceof Error &&
    /UNIQUE constraint failed:\s*DuhGoodsImportRecord\.evidenceHash/i.test(
      err.message
    )
  );
}

function isIdentityVersionUniqueError(err: unknown): boolean {
  return (
    err instanceof Error &&
    /UNIQUE constraint failed:\s*DuhGoodsImportRecord\.(identityKey|evidenceVersion)/i.test(
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
