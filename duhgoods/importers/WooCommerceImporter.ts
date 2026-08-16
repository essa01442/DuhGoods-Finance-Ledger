import { ImportAdapter, ImportedTransaction, SourceType } from './types';

interface WooOrder {
  id: number | string;
  date_created?: string;
  date_paid?: string;
  currency?: string;
  total?: string | number;
  total_tax?: string | number;
  shipping_total?: string | number;
  discount_total?: string | number;
  status?: string;
  [key: string]: unknown;
}

export class WooCommerceImporter implements ImportAdapter {
  readonly sourceType: SourceType = 'woocommerce';

  parse(input: string | Buffer): ImportedTransaction[] {
    const raw = typeof input === 'string' ? input : input.toString('utf8');
    const parsed: unknown = JSON.parse(raw);

    if (!Array.isArray(parsed)) {
      throw new Error('WooCommerce input must be a JSON array of orders');
    }

    return (parsed as WooOrder[]).map((order) => this._mapOrder(order));
  }

  private _mapOrder(order: WooOrder): ImportedTransaction {
    const gross = Number(order.total ?? 0);
    const tax = Number(order.total_tax ?? 0);
    const shipping = Number(order.shipping_total ?? 0);
    const discount = Number(order.discount_total ?? 0);

    const dateStr = order.date_paid ?? order.date_created ?? '';
    const transactionDate = dateStr ? new Date(dateStr) : new Date();

    const transactionType = order.status === 'refunded' ? 'refund' : 'order';

    return {
      sourceId: String(order.id),
      sourceType: 'woocommerce',
      transactionType,
      transactionDate,
      currency: order.currency ?? 'SAR',
      grossAmount: gross,
      fees: shipping - discount,
      taxes: tax,
      netAmount: gross - tax,
      rawData: order,
    };
  }
}
