import { getMoneyMaker } from 'pesa';
import {
  ImportAdapter,
  ImportedTransaction,
  ImportValidationError,
  SourceType,
  TransactionType,
} from './types';

const _pesa = getMoneyMaker({});

/**
 * Column mapping + parser configuration resolved from a DuhGoodsImportProfile record.
 *
 * columnMappings: logical field name → source column name.
 *   Logical field names understood by this importer:
 *     id          – external source transaction ID (or reference for bank rows)
 *     date        – transaction date (any parseable ISO-like string)
 *     type        – transaction type string (mapped via parserOptions.typeMap)
 *     currency    – ISO 4217 currency code (fallback: defaultCurrency)
 *     gross       – grossAmount decimal string
 *     fee         – fees decimal string
 *     tax         – taxes decimal string
 *     net         – netAmount decimal string (computed if absent)
 *     debit       – debit magnitude for bank_statement rows
 *     credit      – credit magnitude for bank_statement rows
 *     reference   – alternative sourceId column for bank rows
 *
 * parserOptions (all optional):
 *   delimiter    – CSV field separator (default ',')
 *   skipRows     – number of leading rows to skip before the header (default 0)
 *   defaultType  – fallback transaction type when the type column is absent
 *   typeMap      – { sourceValue: targetType } for mapping source strings
 *                  e.g. { "payout": "settlement", "withdrawal": "bank_debit" }
 */
export interface ProfileData {
  sourceType: string;
  fileFormat: string;
  defaultCurrency?: string;
  columnMappings: Record<string, string>;
  parserOptions: Record<string, unknown>;
}

const DECIMAL_RE = /^-?(\d+\.?\d*|\.\d+)$/;

function parseDecimalString(
  value: unknown,
  field: string,
  errors: string[]
): string {
  if (value === undefined || value === null || value === '') return '0';
  const str = String(value).trim();
  if (!DECIMAL_RE.test(str)) {
    errors.push(`${field} is not a valid finite number: "${str}"`);
    return '0';
  }
  return str;
}

// ---------------------------------------------------------------------------
// Minimal RFC 4180 CSV parser (no external dependency)
// ---------------------------------------------------------------------------

function splitCSVRow(line: string, delimiter: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === delimiter && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

function parseCSV(
  text: string,
  delimiter: string,
  skipRows: number
): Record<string, unknown>[] {
  const allLines = text.split(/\r?\n/);
  const lines = allLines.slice(skipRows);
  const nonEmpty = lines.filter((l) => l.trim().length > 0);
  if (nonEmpty.length === 0) return [];
  const headers = splitCSVRow(nonEmpty[0], delimiter).map((h) => h.trim());
  const result: Record<string, unknown>[] = [];
  for (let i = 1; i < nonEmpty.length; i++) {
    const vals = splitCSVRow(nonEmpty[i], delimiter);
    const row: Record<string, unknown> = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = (vals[j] ?? '').trim();
    }
    result.push(row);
  }
  return result;
}

// ---------------------------------------------------------------------------
// ProfileDrivenImporter
// ---------------------------------------------------------------------------

const VALID_TRANSACTION_TYPES = new Set<string>([
  'order',
  'payment',
  'refund',
  'fee',
  'bank_credit',
  'bank_debit',
  'settlement',
  'chargeback',
]);

export class ProfileDrivenImporter implements ImportAdapter {
  readonly sourceType: SourceType;

  constructor(private readonly profile: ProfileData) {
    this.sourceType = profile.sourceType as SourceType;
  }

  parse(input: string | Buffer): ImportedTransaction[] {
    const raw = typeof input === 'string' ? input : input.toString('utf8');
    const delimiter = String(this.profile.parserOptions.delimiter ?? ',');
    const skipRows = Number(this.profile.parserOptions.skipRows ?? 0);

    let rows: Record<string, unknown>[];
    if (this.profile.fileFormat === 'csv') {
      rows = parseCSV(raw, delimiter, skipRows);
    } else if (this.profile.fileFormat === 'json') {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) {
        throw new Error('Profile JSON input must be a JSON array of rows');
      }
      rows = parsed as Record<string, unknown>[];
    } else {
      throw new Error(
        `Unsupported file format "${this.profile.fileFormat}" — supported: json, csv`
      );
    }

    const results: ImportedTransaction[] = [];
    for (let idx = 0; idx < rows.length; idx++) {
      const txn = this._mapRow(rows[idx], idx);
      if (txn !== null) results.push(txn);
    }
    return results;
  }

  private _mapRow(
    row: Record<string, unknown>,
    idx: number
  ): ImportedTransaction | null {
    const mappings = this.profile.columnMappings;
    const opts = this.profile.parserOptions;
    const typeMap = (opts.typeMap as Record<string, string> | undefined) ?? {};

    // Resolve a logical field from the source row using the column mapping.
    // Falls back to the logical name itself if no mapping entry is present.
    const get = (logicalField: string): unknown => {
      const colName = mappings[logicalField];
      if (colName !== undefined && row[colName] !== undefined)
        return row[colName];
      if (row[logicalField] !== undefined) return row[logicalField];
      return undefined;
    };

    const errors: string[] = [];
    const srcType = this.sourceType;

    // --- Source ID ---
    const rawRef = String(get('reference') ?? '').trim();
    const rawId = String(get('id') ?? rawRef).trim();
    if (!rawId && srcType !== 'bank_statement') {
      errors.push(`row ${idx}: id/reference is missing`);
    }

    // --- Date ---
    const dateStr = String(get('date') ?? '').trim();
    if (!dateStr) errors.push(`row ${idx}: date is missing`);
    const transactionDate = dateStr ? new Date(dateStr) : null;
    if (transactionDate !== null && isNaN(transactionDate.getTime())) {
      errors.push(`row ${idx}: date is invalid: "${dateStr}"`);
    }

    // --- Currency ---
    const currency = String(
      get('currency') ?? this.profile.defaultCurrency ?? ''
    )
      .trim()
      .toUpperCase();
    if (!currency) {
      errors.push(
        `row ${idx}: currency is missing and no defaultCurrency set in profile`
      );
    }

    if (srcType === 'bank_statement') {
      // Bank rows use debit/credit columns.
      const debitStr = parseDecimalString(get('debit'), 'debit', errors);
      const creditStr = parseDecimalString(get('credit'), 'credit', errors);

      if (errors.length > 0) {
        throw new ImportValidationError(errors, rawId || undefined, row);
      }

      // Use pesa for zero-comparison — never JS Number.
      const isCredit = !_pesa(creditStr).isZero();
      const isDebit = !_pesa(debitStr).isZero();

      if (!isCredit && !isDebit) {
        // Zero row — skip silently (blank CSV trailing row etc.)
        return null;
      }

      const grossAmount = isCredit ? creditStr : debitStr;
      const netAmount = isCredit
        ? creditStr
        : _pesa('0').sub(_pesa(debitStr)).store;

      return {
        sourceId: rawId,
        sourceType: srcType,
        transactionType: (isCredit
          ? 'bank_credit'
          : 'bank_debit') as TransactionType,
        transactionDate: transactionDate!,
        currency,
        grossAmount,
        fees: '0',
        taxes: '0',
        netAmount,
        rawData: row,
        normalizedMeta: { rowLocator: idx },
      };
    }

    // --- PSP / manual: gross / fee / tax / net ---
    const rawTypeRaw = String(get('type') ?? opts.defaultType ?? '')
      .toLowerCase()
      .trim();
    const mappedType = typeMap[rawTypeRaw] ?? rawTypeRaw;

    if (!VALID_TRANSACTION_TYPES.has(mappedType)) {
      errors.push(
        `row ${idx}: unknown transaction type "${mappedType}" — must be one of: ${[
          ...VALID_TRANSACTION_TYPES,
        ].join(', ')}`
      );
    }

    const gross = parseDecimalString(get('gross'), 'gross', errors);
    const fee = parseDecimalString(get('fee'), 'fee', errors);
    const tax = parseDecimalString(get('tax'), 'tax', errors);
    const netRaw = get('net');
    const net =
      netRaw !== undefined && netRaw !== null && netRaw !== ''
        ? parseDecimalString(netRaw, 'net', errors)
        : _pesa(gross).sub(_pesa(fee)).sub(_pesa(tax)).store;

    if (errors.length > 0) {
      throw new ImportValidationError(errors, rawId || undefined, row);
    }

    return {
      sourceId: rawId,
      sourceType: srcType,
      transactionType: mappedType as TransactionType,
      transactionDate: transactionDate!,
      currency,
      grossAmount: gross,
      fees: fee,
      taxes: tax,
      netAmount: net,
      rawData: row,
    };
  }
}
