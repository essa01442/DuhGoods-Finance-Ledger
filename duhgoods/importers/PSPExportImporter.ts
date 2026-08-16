import {
  ImportAdapter,
  ImportedTransaction,
  ImportValidationError,
  SourceType,
  TransactionType,
} from './types';

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
    const sourceId = String(row.id ?? `psp-${idx}`);
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

    const dateStr = (row.date ?? row.created ?? '').trim();
    if (!dateStr) {
      errors.push('transaction date is missing');
    }
    const transactionDate = dateStr ? new Date(dateStr) : null;
    if (transactionDate !== null && isNaN(transactionDate.getTime())) {
      errors.push(`transaction date is invalid: "${dateStr}"`);
    }

    const gross = parseFiniteNumber(row.gross, 'gross', errors);
    const fee = parseFiniteNumber(row.fee, 'fee', errors);
    const tax = parseFiniteNumber(row.tax, 'tax', errors);
    const net =
      row.net !== undefined
        ? parseFiniteNumber(row.net, 'net', errors)
        : gross - fee - tax;

    if (errors.length > 0) {
      throw new ImportValidationError(
        errors,
        sourceId,
        row as Record<string, unknown>
      );
    }

    return {
      sourceId,
      sourceType: 'psp_export',
      transactionType: TYPE_MAP[rawType],
      transactionDate: transactionDate!,
      currency: (row.currency ?? 'SAR').toUpperCase(),
      grossAmount: gross,
      fees: fee,
      taxes: tax,
      netAmount: net,
      rawData: row,
    };
  }
}

function parseFiniteNumber(
  value: unknown,
  field: string,
  errors: string[]
): number {
  const n = Number(value);
  if (!isFinite(n)) {
    errors.push(`${field} is not a valid finite number: ${String(value)}`);
    return 0;
  }
  return n;
}
