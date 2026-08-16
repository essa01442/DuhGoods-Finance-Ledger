import { getMoneyMaker } from 'pesa';
import {
  ImportAdapter,
  ImportedTransaction,
  ImportValidationError,
  SourceType,
  TransactionType,
} from './types';

const _pesa = getMoneyMaker({});

interface PSPRow {
  id?: string | number;
  type?: string;
  date?: string;
  created?: string;
  currency?: string;
  gross?: string | number;
  fee?: string | number;
  tax?: string | number;
  net?: string | number;
  [key: string]: unknown;
}

const SUPPORTED_TYPES: ReadonlySet<string> = new Set([
  'payment',
  'payout',
  'refund',
  'chargeback',
  'fee',
  'transfer',
]);

const TYPE_MAP: Record<string, TransactionType> = {
  payment: 'payment',
  payout: 'settlement',
  refund: 'refund',
  chargeback: 'chargeback',
  fee: 'fee',
  transfer: 'settlement',
};

export class PSPExportImporter implements ImportAdapter {
  readonly sourceType: SourceType = 'psp_export';

  parse(input: string | Buffer): ImportedTransaction[] {
    const raw = typeof input === 'string' ? input : input.toString('utf8');
    const parsed: unknown = JSON.parse(raw);

    if (!Array.isArray(parsed)) {
      throw new Error('PSP export input must be a JSON array of rows');
    }

    return (parsed as PSPRow[]).map((row, idx) => this._mapRow(row, idx));
  }

  private _mapRow(row: PSPRow, idx: number): ImportedTransaction {
    const errors: string[] = [];

    // External source ID — must come from the PSP; row index is only an
    // internal locator for the error report, never a source-system ID.
    const rawId =
      row.id !== undefined && row.id !== null ? String(row.id).trim() : '';
    if (!rawId) {
      errors.push(`transaction id is missing (row index: ${idx})`);
    }

    const rawType = (row.type ?? '').toLowerCase().trim();

    if (!rawType) {
      errors.push('transaction type is missing');
    } else if (!SUPPORTED_TYPES.has(rawType)) {
      errors.push(
        `unsupported PSP transaction type "${rawType}" — must be one of: ${[
          ...SUPPORTED_TYPES,
        ].join(', ')}`
      );
    }

    // Currency must be present in the source record. There is no legitimate
    // default — an unknown currency is a data quality failure.
    const currencyStr = (row.currency ?? '').trim();
    if (!currencyStr) {
      errors.push('currency is missing or blank');
    }

    const dateStr = (row.date ?? row.created ?? '').trim();
    if (!dateStr) {
      errors.push('transaction date is missing');
    }
    const transactionDate = dateStr ? new Date(dateStr) : null;
    if (transactionDate !== null && isNaN(transactionDate.getTime())) {
      errors.push(`transaction date is invalid: "${dateStr}"`);
    }

    // Amounts stored as decimal strings to preserve source precision.
    // parseDecimalString validates and returns the original source string.
    const gross = parseDecimalString(row.gross, 'gross', errors);
    const fee = parseDecimalString(row.fee, 'fee', errors);
    const tax = parseDecimalString(row.tax, 'tax', errors);

    // Use source-provided net if available; otherwise compute via pesa
    // arithmetic to avoid floating-point accumulation errors.
    const net =
      row.net !== undefined
        ? parseDecimalString(row.net, 'net', errors)
        : _pesa(gross).sub(_pesa(fee)).sub(_pesa(tax)).store;

    if (errors.length > 0) {
      throw new ImportValidationError(
        errors,
        rawId || undefined,
        row as Record<string, unknown>
      );
    }

    return {
      sourceId: rawId,
      sourceType: 'psp_export',
      transactionType: TYPE_MAP[rawType],
      transactionDate: transactionDate!,
      currency: currencyStr.toUpperCase(),
      grossAmount: gross,
      fees: fee,
      taxes: tax,
      netAmount: net,
      rawData: row as Record<string, unknown>,
    };
  }
}

/**
 * Validates that `value` is a parseable finite decimal number and returns the
 * ORIGINAL source string — never a JS Number — to preserve source precision.
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
