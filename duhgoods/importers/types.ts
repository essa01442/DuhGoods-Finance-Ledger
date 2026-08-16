export type SourceType = 'woocommerce' | 'bank_statement' | 'psp_export' | 'manual';

export type TransactionType =
  | 'order'
  | 'payment'
  | 'refund'
  | 'fee'
  | 'bank_credit'
  | 'bank_debit'
  | 'settlement'
  | 'chargeback';

export interface ImportedTransaction {
  sourceId: string;
  sourceType: SourceType;
  transactionType: TransactionType;
  transactionDate: Date;
  currency: string;
  grossAmount: number;
  fees: number;
  taxes: number;
  netAmount: number;
  rawData: Record<string, unknown>;
}

export interface ImportResult {
  sourceId: string;
  imported: number;
  skipped: number;
  errors: ImportError[];
}

export interface ImportError {
  sourceId?: string;
  message: string;
  raw?: unknown;
}

/**
 * Thrown by adapters when source data fails validation before a transaction
 * can be safely constructed. Callers must catch this and produce an ImportError.
 */
export class ImportValidationError extends Error {
  readonly validationErrors: string[];
  readonly sourceId: string | undefined;
  readonly raw: Record<string, unknown>;

  constructor(
    validationErrors: string[],
    sourceId: string | undefined,
    raw: Record<string, unknown>
  ) {
    super(validationErrors.join('; '));
    this.name = 'ImportValidationError';
    this.validationErrors = validationErrors;
    this.sourceId = sourceId;
    this.raw = raw;
  }
}

export interface ImportAdapter {
  readonly sourceType: SourceType;
  parse(
    input: string | Buffer
  ): ImportedTransaction[] | Promise<ImportedTransaction[]>;
}
