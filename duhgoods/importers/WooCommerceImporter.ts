import { getMoneyMaker } from 'pesa';
import {
  ImportAdapter,
  ImportedTransaction,
  ImportValidationError,
  SourceType,
} from './types';

const _pesa = getMoneyMaker({});

interface WooRefund {
  id: number | string;
  date_created?: string;
  amount?: string | number;
  reason?: string;
  [key: string]: unknown;
}

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
  refunds?: WooRefund[];
  [key: string]: unknown;
}

// Statuses that represent a completed, paid order worth importing as a revenue event.
const PAID_STATUSES: ReadonlySet<string> = new Set(['completed', 'processing']);

// A fully-refunded order — import its refunds[], not the order itself.
const REFUNDED_STATUSES: ReadonlySet<string> = new Set(['refunded']);

// Statuses that produce no importable financial event — skip cleanly.
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

    const errors: string[] = [];

    // Currency must come from the source record — no manufactured default.
    const currencyStr = (order.currency ?? '').trim();
    if (!currencyStr) {
      errors.push('currency is missing or blank');
    }

    const dateStr = (order.date_paid ?? order.date_created ?? '').trim();
    if (!dateStr) {
      errors.push('order date (date_paid or date_created) is missing');
    }
    const transactionDate = dateStr ? new Date(dateStr) : null;
    if (transactionDate !== null && isNaN(transactionDate.getTime())) {
      errors.push(`order date is invalid: "${dateStr}"`);
    }

    // Decimal strings — validated, source precision preserved.
    const grossStr = parseDecimalString(order.total, 'total', errors);
    const totalTaxStr = parseDecimalString(
      order.total_tax,
      'total_tax',
      errors
    );
    const shippingTotalStr = parseDecimalString(
      order.shipping_total,
      'shipping_total',
      errors
    );
    const discountTotalStr = parseDecimalString(
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

    const currency = currencyStr.toUpperCase();
    const refunds: WooRefund[] = Array.isArray(order.refunds)
      ? order.refunds
      : [];

    if (REFUNDED_STATUSES.has(status)) {
      // Fully-refunded order: import individual refund records when present,
      // otherwise synthesise a single full-reversal from order totals.
      if (refunds.length > 0) {
        return refunds.map((refund) =>
          this._mapRefund(refund, order, currency)
        );
      }
      // Synthetic full refund — negate order totals; no rawData mutation.
      const negGross = negate(grossStr);
      const negTax = negate(totalTaxStr);
      const netAmount = _pesa(negGross).sub(_pesa(negTax)).store;
      return [
        {
          sourceId,
          sourceType: 'woocommerce',
          transactionType: 'refund',
          transactionDate: transactionDate!,
          currency,
          grossAmount: negGross,
          fees: '0',
          taxes: negTax,
          netAmount,
          rawData: order as Record<string, unknown>,
          normalizedMeta: {
            shippingTotal: shippingTotalStr,
            discountTotal: discountTotalStr,
            syntheticFullRefund: true,
          },
        },
      ];
    }

    // PAID order transaction plus any partial refunds recorded in refunds[].
    const netAmount = _pesa(grossStr).sub(_pesa(totalTaxStr)).store;
    const orderTxn: ImportedTransaction = {
      sourceId,
      sourceType: 'woocommerce',
      transactionType: 'order',
      transactionDate: transactionDate!,
      currency,
      grossAmount: grossStr,
      fees: '0',
      taxes: totalTaxStr,
      netAmount,
      rawData: order as Record<string, unknown>,
      normalizedMeta: {
        shippingTotal: shippingTotalStr,
        discountTotal: discountTotalStr,
      },
    };

    const refundTxns = refunds.map((refund) =>
      this._mapRefund(refund, order, currency)
    );

    return [orderTxn, ...refundTxns];
  }

  private _mapRefund(
    refund: WooRefund,
    parentOrder: WooOrder,
    currency: string
  ): ImportedTransaction {
    const errors: string[] = [];
    const refundId = String(refund.id);
    const parentOrderId = String(parentOrder.id);

    // Prefer refund's own date; fall back to parent order date.
    const dateStr = (
      refund.date_created ??
      parentOrder.date_paid ??
      parentOrder.date_created ??
      ''
    ).trim();
    if (!dateStr) {
      errors.push(`refund ${refundId}: date is missing`);
    }
    const transactionDate = dateStr ? new Date(dateStr) : null;
    if (transactionDate !== null && isNaN(transactionDate.getTime())) {
      errors.push(`refund ${refundId}: date is invalid: "${dateStr}"`);
    }

    // WooCommerce refund amounts are POSITIVE in the source; negate for convention.
    const rawAmount = parseDecimalString(refund.amount, 'amount', errors);

    if (errors.length > 0) {
      throw new ImportValidationError(
        errors,
        refundId,
        refund as Record<string, unknown>
      );
    }

    const negAmount = negate(rawAmount);

    return {
      sourceId: refundId,
      sourceType: 'woocommerce',
      transactionType: 'refund',
      transactionDate: transactionDate!,
      currency,
      grossAmount: negAmount,
      fees: '0',
      taxes: '0',
      netAmount: negAmount,
      rawData: refund as Record<string, unknown>,
      normalizedMeta: { parentOrderId },
    };
  }
}

/** Returns the additive inverse of a decimal string via pesa arithmetic. */
function negate(str: string): string {
  return _pesa('0').sub(_pesa(str)).store;
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
