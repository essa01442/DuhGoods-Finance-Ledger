import { ImportAdapter, ImportedTransaction, SourceType } from './types';

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

    return (parsed as BankRow[])
      .filter((row) => row.date)
      .map((row, idx) => this._mapRow(row, idx));
  }

  private _mapRow(row: BankRow, idx: number): ImportedTransaction {
    const debit = Math.abs(Number(row.debit ?? 0));
    const credit = Math.abs(Number(row.credit ?? 0));
    const isCredit = credit > 0;

    const sourceId = row.reference ?? `row-${idx}`;
    const transactionDate = new Date(row.date);

    return {
      sourceId,
      sourceType: 'bank_statement',
      transactionType: isCredit ? 'bank_credit' : 'bank_debit',
      transactionDate,
      currency: this.currency,
      grossAmount: isCredit ? credit : debit,
      fees: 0,
      taxes: 0,
      netAmount: isCredit ? credit : -debit,
      rawData: row,
    };
  }
}
