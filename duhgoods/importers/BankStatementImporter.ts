import {
  ImportAdapter,
  ImportedTransaction,
  ImportValidationError,
  SourceType,
} from './types';

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

    // Row-index as internal sequence only — NOT a source-system identity.
    // The source reference field is the external ID; fall back clearly.
    const sourceId = row.reference?.trim()
      ? row.reference.trim()
      : `internal-seq-${idx}`;
    const hasSourceRef = Boolean(row.reference?.trim());

    // Date validation — missing or invalid date is a hard rejection.
    const dateStr = (row.date ?? '').trim();
    if (!dateStr) {
      errors.push('transaction date is missing');
    }
    const transactionDate = dateStr ? new Date(dateStr) : null;
    if (transactionDate !== null && isNaN(transactionDate.getTime())) {
      errors.push(`transaction date is invalid: "${dateStr}"`);
    }

    // Preserve original signs from source — do NOT use Math.abs which hides malformed data.
    const rawDebit = parseMaybeNumber(row.debit);
    const rawCredit = parseMaybeNumber(row.credit);

    if (rawDebit !== null && !isFinite(rawDebit)) {
      errors.push(`debit is not a valid finite number: ${String(row.debit)}`);
    }
    if (rawCredit !== null && !isFinite(rawCredit)) {
      errors.push(`credit is not a valid finite number: ${String(row.credit)}`);
    }

    const debit = rawDebit ?? 0;
    const credit = rawCredit ?? 0;

    // Reject ambiguous rows where both debit and credit are non-zero.
    if (debit !== 0 && credit !== 0) {
      errors.push(
        `ambiguous row: both debit (${debit}) and credit (${credit}) are non-zero`
      );
    }

    // Reject zero-value rows — they carry no financial meaning.
    if (debit === 0 && credit === 0) {
      errors.push('zero-value row: both debit and credit are zero');
    }

    if (errors.length > 0) {
      throw new ImportValidationError(
        errors,
        hasSourceRef ? sourceId : undefined,
        row as Record<string, unknown>
      );
    }

    const isCredit = credit !== 0;

    return {
      sourceId,
      sourceType: 'bank_statement',
      transactionType: isCredit ? 'bank_credit' : 'bank_debit',
      transactionDate: transactionDate!,
      currency: this.currency,
      // Preserve original sign from source — credit is positive inflow,
      // debit is negative outflow.
      grossAmount: isCredit ? credit : debit,
      fees: 0,
      taxes: 0,
      netAmount: isCredit ? credit : -debit,
      rawData: {
        ...row,
        _hasSourceRef: hasSourceRef,
      },
    };
  }
}

function parseMaybeNumber(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  return Number(value);
}
