import { getMoneyMaker } from 'pesa';
import {
  ImportAdapter,
  ImportedTransaction,
  ImportValidationError,
  SourceType,
} from './types';

const _pesa = getMoneyMaker({});

/**
 * IDENTITY FORMULA for bank statement transactions:
 *
 *   sourceType = 'bank_statement'
 *   sourceId   = row.reference (source-system external transaction ID)
 *              — only set when the bank provides a reference
 *   rowLocator = row index within this import file (internal, for error reporting)
 *   evidenceHash = SHA-256(sourceType + sourceId + canonical(rawData))
 *
 * Rows WITHOUT an external reference (hasSourceRef = false) carry sourceId = ''
 * and are recorded in normalizedMeta.rowLocator for traceability.  They can still
 * be imported, but idempotency relies on rawData content rather than an external ID.
 *
 * Two rows with the SAME reference from DIFFERENT source namespaces/accounts do not
 * collide because the orchestrator scopes identity by sourceType + sourceId + rawData.
 *
 * CURRENCY must be provided explicitly.  There is no silent SAR fallback; importing
 * without knowing the currency of the account would manufacture a financial fact.
 */

/** Validates an ISO 4217-style currency code: 3 uppercase letters. */
function validateCurrency(currency: unknown): string {
  if (currency === undefined || currency === null) {
    throw new Error(
      'BankStatementImporter requires an explicit currency; no silent SAR default — ' +
        'pass the account or import configuration currency.'
    );
  }
  const code = String(currency).trim();
  if (code.length === 0) {
    throw new Error(
      'BankStatementImporter currency must not be blank — ' +
        'pass the account or import configuration currency.'
    );
  }
  if (!/^[A-Z]{3}$/.test(code)) {
    throw new Error(
      `BankStatementImporter currency "${code}" is malformed — ` +
        'expected exactly 3 uppercase letters (ISO 4217 style, e.g. SAR, USD, EUR).'
    );
  }
  return code;
}

interface BankRow {
  date: string;
  description?: string;
  debit?: string | number;
  credit?: string | number;
  balance?: string | number;
  reference?: string;
  [key: string]: unknown;
}

export class BankStatementImporter implements ImportAdapter {
  readonly sourceType: SourceType = 'bank_statement';

  private readonly currency: string;

  /**
   * @param currency — Required.  Must be a 3-letter ISO 4217 code (SAR, USD, EUR…).
   *   Omitting or blanking currency throws immediately so callers cannot accidentally
   *   import statements with a manufactured currency denomination.
   */
  constructor(currency: string) {
    this.currency = validateCurrency(currency);
  }

  parse(input: string | Buffer): ImportedTransaction[] {
    const raw = typeof input === 'string' ? input : input.toString('utf8');
    const parsed: unknown = JSON.parse(raw);

    if (!Array.isArray(parsed)) {
      throw new Error('Bank statement input must be a JSON array of rows');
    }

    return (parsed as BankRow[]).map((row, idx) => this._mapRow(row, idx));
  }

  private _mapRow(row: BankRow, idx: number): ImportedTransaction {
    const errors: string[] = [];

    // A. External source-system transaction ID — only when provided by the bank.
    // B. Internal row locator (idx) is used ONLY for error messages, never as identity.
    const refTrimmed = row.reference?.trim() ?? '';
    const hasSourceRef = refTrimmed.length > 0;

    // sourceId is the bank's external reference, or empty string for reference-less rows.
    // Row index is NEVER placed in sourceId; it is stored in normalizedMeta for traceability.
    const sourceId = hasSourceRef ? refTrimmed : '';

    const dateStr = (row.date ?? '').trim();
    if (!dateStr) {
      errors.push('transaction date is missing');
    }
    const transactionDate = dateStr ? new Date(dateStr) : null;
    if (transactionDate !== null && isNaN(transactionDate.getTime())) {
      errors.push(`transaction date is invalid: "${dateStr}"`);
    }

    // Parse as original strings; use pesa for ALL zero/sign comparisons.
    const debitStr = parseDecimalString(row.debit, 'debit', errors);
    const creditStr = parseDecimalString(row.credit, 'credit', errors);

    if (errors.length === 0) {
      // Use pesa for monetary zero-comparison — never JS Number.
      const debitZero = _pesa(debitStr).isZero();
      const creditZero = _pesa(creditStr).isZero();

      if (!debitZero && !creditZero) {
        errors.push(
          `ambiguous row: both debit (${debitStr}) and credit (${creditStr}) are non-zero`
        );
      } else if (debitZero && creditZero) {
        errors.push('zero-value row: both debit and credit are zero');
      }
    }

    if (errors.length > 0) {
      throw new ImportValidationError(
        errors,
        hasSourceRef ? sourceId : undefined,
        row as Record<string, unknown>
      );
    }

    // Use pesa for direction decision — never JS Number comparison.
    const isCredit = !_pesa(creditStr).isZero();

    return {
      sourceId,
      sourceType: 'bank_statement',
      transactionType: isCredit ? 'bank_credit' : 'bank_debit',
      transactionDate: transactionDate!,
      currency: this.currency,
      // grossAmount holds the magnitude (positive) in both directions.
      grossAmount: isCredit ? creditStr : debitStr,
      fees: '0',
      taxes: '0',
      // netAmount: credit is positive inflow; debit is negative outflow.
      netAmount: isCredit ? creditStr : _pesa('0').sub(_pesa(debitStr)).store,
      rawData: row as Record<string, unknown>,
      normalizedMeta: {
        // Whether the bank provided its own external reference.
        hasSourceRef,
        // Row index within the import file — internal locator, never used as identity.
        rowLocator: idx,
      },
    };
  }
}

/**
 * Strict decimal grammar — rejects scientific notation, hex, Infinity, NaN.
 * Accepts: optional leading minus, integer part, optional decimal part.
 */
const DECIMAL_RE = /^-?(\d+\.?\d*|\.\d+)$/;

/**
 * Validates that `value` is a strict finite decimal string and returns the
 * ORIGINAL source string — never a JS Number — to preserve source precision.
 * Returns '0' on empty/null/undefined (not an error — blank debit/credit is normal).
 */
function parseDecimalString(
  value: unknown,
  field: string,
  errors: string[]
): string {
  if (value === undefined || value === null || value === '') return '0';
  const str = String(value).trim();
  if (!DECIMAL_RE.test(str)) {
    errors.push(`${field} is not a valid finite number: ${str}`);
    return '0';
  }
  return str;
}
