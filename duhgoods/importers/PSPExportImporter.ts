import {
  ImportAdapter,
  ImportedTransaction,
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
    const sourceId = String(row.id ?? `psp-${idx}`);
    const rawType = (row.type ?? '').toLowerCase();
    const transactionType: TransactionType = TYPE_MAP[rawType] ?? 'payment';

    const dateStr = row.date ?? row.created ?? '';
    const transactionDate = dateStr ? new Date(dateStr) : new Date();

    const gross = Number(row.gross ?? 0);
    const fee = Number(row.fee ?? 0);
    const tax = Number(row.tax ?? 0);
    const net = row.net !== undefined ? Number(row.net) : gross - fee - tax;

    return {
      sourceId,
      sourceType: 'psp_export',
      transactionType,
      transactionDate,
      currency: (row.currency ?? 'SAR').toUpperCase(),
      grossAmount: gross,
      fees: fee,
      taxes: tax,
      netAmount: net,
      rawData: row,
    };
  }
}
