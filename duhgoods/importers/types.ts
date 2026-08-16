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

/**
 * SIGN CONVENTIONS for ImportedTransaction amounts.
 *
 * All monetary amounts are decimal strings (never JS Number) to preserve
 * exact source precision. Computed amounts (e.g. netAmount) are produced
 * via pesa arithmetic to avoid floating-point accumulation errors.
 *
 * transactionType  | grossAmount | fees       | taxes     | netAmount
 * -----------------+-------------+------------+-----------+-----------
 * order            | positive    | '0'        | positive  | positive (gross − taxes)
 * payment          | positive    | positive   | positive  | positive (gross − fees − taxes)
 * refund           | negative    | ≤ '0'      | negative  | negative
 * chargeback       | negative    | positive   | '0'       | negative (gross − fees)
 * fee              | '0'         | positive   | '0'       | negative (−fees)
 * settlement       | positive    | '0'        | '0'       | positive
 * bank_credit      | positive    | '0'        | '0'       | positive
 * bank_debit       | positive    | '0'        | '0'       | negative (outflow: −gross)
 *
 * Note on bank_debit: grossAmount holds the MAGNITUDE (positive); netAmount
 * is negative to indicate cash outflow. All other types share the same sign
 * for gross and net.
 *
 * Note on refunds/chargebacks: the PSP source typically provides negative
 * amounts already. WooCommerce refund amounts are positive in the source;
 * adapters MUST negate them to conform to this convention.
 */
export interface ImportedTransaction {
  sourceId: string;
  sourceType: SourceType;
  transactionType: TransactionType;
  transactionDate: Date;
  currency: string;
  grossAmount: string;
  fees: string;
  taxes: string;
  netAmount: string;
  /** Exact source bytes/JSON — NEVER augmented or mutated by adapters. */
  rawData: Record<string, unknown>;
  /** Adapter-derived metadata not present in the source (computed fields,
   *  internal flags, denormalized parent references). Kept separate from
   *  rawData so evidence integrity is preserved. */
  normalizedMeta?: Record<string, unknown>;
}

export interface ImportResult {
  sourceId: string;
  imported: number;
  skipped: number;
  exceptions: number;
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
