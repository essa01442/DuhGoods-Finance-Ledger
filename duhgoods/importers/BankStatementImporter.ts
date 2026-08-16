import { getMoneyMaker } from 'pesa';
import {
  ImportAdapter,
  ImportedTransaction,
  ImportValidationError,
  SourceType,
} from './types';

const _pesa = getMoneyMaker({});

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

  constructor(currency = 'SAR') {
    this.currency = currency;
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

    // Row-index is an internal locator only — NOT a source-system identity.
    const refTrimmed = row.reference?.trim() ?? '';
    const hasSourceRef = refTrimmed.length > 0;
    const sourceId = hasSourceRef ? refTrimmed : `internal-seq-${idx}`;

    const dateStr = (row.date ?? '').trim();
    if (!dateStr) {
      errors.push('transaction date is missing');
    }
    const transactionDate = dateStr ? new Date(dateStr) : null;
    if (transactionDate !== null && isNaN(transactionDate.getTime())) {
      errors.push(`transaction date is invalid: "${dateStr}"`);
    }

    // Parse as strings first to validate, then check numeric validity.
    const debitStr = parseDecimalString(row.debit, 'debit', errors);
    const creditStr = parseDecimalString(row.credit, 'credit', errors);

    const debitNum = Number(debitStr);
    const creditNum = Number(creditStr);

    if (errors.length === 0) {
      if (debitNum !== 0 && creditNum !== 0) {
        errors.push(
          `ambiguous row: both debit (${debitStr}) and credit (${creditStr}) are non-zero`
        );
      } else if (debitNum === 0 && creditNum === 0) {
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

    const isCredit = creditNum !== 0;

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
      normalizedMeta: { hasSourceRef },
    };
  }
}

/**
 * Validates that `value` is a parseable finite decimal number and returns the
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
  const n = Number(str);
  if (!isFinite(n)) {
    errors.push(`${field} is not a valid finite number: ${str}`);
    return '0';
  }
  return str;
}
