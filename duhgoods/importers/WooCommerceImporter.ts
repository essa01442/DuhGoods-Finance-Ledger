import {
  ImportAdapter,
  ImportedTransaction,
  ImportValidationError,
  SourceType,
  TransactionType,
} from './types';

interface WooOrder {
  id: number | string;
  date_created?: string;
  date_paid?: string;
  currency?: string;
  total?: string | number;
  total_tax?: string | number;
  shipping_total?: string | number;
  discount_total?: string | number;
  total_shipping_tax?: string | number;
  payment_method?: string;
  status?: string;
  [key: string]: unknown;
}

// Statuses that represent a completed, paid order worth importing as a revenue event.
const PAID_STATUSES: ReadonlySet<string> = new Set(['completed', 'processing']);

// A full refund on an order — the whole order is reversed.
const REFUNDED_STATUSES: ReadonlySet<string> = new Set(['refunded']);

// Statuses that produce no importable financial event — skip them cleanly.
const SKIPPED_STATUSES: ReadonlySet<string> = new Set([
  'pending',
  'on-hold',
  'failed',
  'cancelled',
  'draft',
  'checkout-draft',
]);

export class WooCommerceImporter implements ImportAdapter {
  readonly sourceType: SourceType = 'woocommerce';

  parse(input: string | Buffer): ImportedTransaction[] {
    const raw = typeof input === 'string' ? input : input.toString('utf8');
    const parsed: unknown = JSON.parse(raw);

    if (!Array.isArray(parsed)) {
      throw new Error('WooCommerce input must be a JSON array of orders');
    }

    return (parsed as WooOrder[]).flatMap((order) => this._mapOrder(order));
  }

  private _mapOrder(order: WooOrder): ImportedTransaction[] {
    const errors: string[] = [];
    const sourceId = String(order.id);
    const status = (order.status ?? '').toLowerCase().trim();

    if (SKIPPED_STATUSES.has(status)) {
      return [];
    }

    if (!PAID_STATUSES.has(status) && !REFUNDED_STATUSES.has(status)) {
      throw new ImportValidationError(
        [
          `unsupported WooCommerce order status "${status}" — supported paid statuses: ${[
            ...PAID_STATUSES,
          ].join(', ')}; supported refund statuses: ${[
            ...REFUNDED_STATUSES,
          ].join(', ')}; skipped statuses: ${[...SKIPPED_STATUSES].join(', ')}`,
        ],
        sourceId,
        order as Record<string, unknown>
      );
    }

    const transactionType: TransactionType = REFUNDED_STATUSES.has(status)
      ? 'refund'
      : 'order';

    const dateStr = (order.date_paid ?? order.date_created ?? '').trim();
    if (!dateStr) {
      errors.push('order date (date_paid or date_created) is missing');
    }
    const transactionDate = dateStr ? new Date(dateStr) : null;
    if (transactionDate !== null && isNaN(transactionDate.getTime())) {
      errors.push(`order date is invalid: "${dateStr}"`);
    }

    // Preserve each WooCommerce financial field separately.
    // Do NOT conflate shipping/discount/tax into a "fees" field —
    // these are distinct concepts that must be preserved as evidence.
    const gross = parseFiniteNumber(order.total, 'total', errors);
    const totalTax = parseFiniteNumber(order.total_tax, 'total_tax', errors);
    const shippingTotal = parseFiniteNumber(
      order.shipping_total,
      'shipping_total',
      errors
    );
    const discountTotal = parseFiniteNumber(
      order.discount_total,
      'discount_total',
      errors
    );

    if (errors.length > 0) {
      throw new ImportValidationError(
        errors,
        sourceId,
        order as Record<string, unknown>
      );
    }

    // Net revenue = gross - tax. Shipping and discount are preserved in rawData
    // for downstream reconciliation; they are NOT mixed into fees here because
    // PSP gateway fees are a separate concept not present in WooCommerce orders.
    const netAmount = gross - totalTax;

    return [
      {
        sourceId,
        sourceType: 'woocommerce',
        transactionType,
        transactionDate: transactionDate!,
        currency: (order.currency ?? 'SAR').toUpperCase(),
        grossAmount: gross,
        fees: 0,
        taxes: totalTax,
        netAmount,
        rawData: {
          ...order,
          _woo_shipping_total: shippingTotal,
          _woo_discount_total: discountTotal,
        },
      },
    ];
  }
}

function parseFiniteNumber(
  value: unknown,
  field: string,
  errors: string[]
): number {
  if (value === undefined || value === null || value === '') return 0;
  const n = Number(value);
  if (!isFinite(n)) {
    errors.push(`${field} is not a valid finite number: ${String(value)}`);
    return 0;
  }
  return n;
}
