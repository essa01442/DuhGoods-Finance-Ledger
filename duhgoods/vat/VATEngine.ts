import type { Fyo } from 'fyo';
import type { Money } from 'pesa';
import { ModelNameEnum } from 'models/types';

export type VATClassification =
  | 'taxable'
  | 'zero_rated'
  | 'exempt'
  | 'out_of_scope'
  | 'input_vat'
  | 'output_vat'
  | 'recoverable_vat'
  | 'non_recoverable_vat'
  | 'review_required'
  | 'not_applicable';

export interface VATLineItem {
  recordName: string;
  transactionType: string;
  transactionDate: Date;
  currency: string;
  grossAmount: Money;
  taxes: Money;
  vatClassification: VATClassification;
  vatAmount: Money;
}

export interface VATPeriodSummary {
  periodStart: Date;
  periodEnd: Date;
  outputVAT: Money;
  inputVAT: Money;
  netVATPayable: Money;
  lineItems: VATLineItem[];
  reviewRequired: number;
  exceptions: string[];
}

/**
 * VAT classification engine.
 *
 * Policy is read from DuhGoodsVATPolicy (a singleton). Classification is
 * determined by transaction type and any explicit override stored on the
 * import record. Unknown classification always becomes review_required —
 * it is never silently assumed to be taxable or zero-rated.
 */
export class VATEngine {
  constructor(private readonly fyo: Fyo) {}

  /**
   * Returns the policy-driven default VAT classification for a transaction type.
   * This is a starting point; the user can override via vatClassification field.
   */
  async getDefaultClassification(
    transactionType: string
  ): Promise<VATClassification> {
    const policy = await this.fyo.doc
      .getDoc(ModelNameEnum.DuhGoodsVATPolicy)
      .catch(() => null);
    if (!policy || !policy.enabled) return 'not_applicable';

    switch (transactionType) {
      case 'order':
      case 'payment':
        return (
          (policy.defaultSalesClassification as VATClassification) || 'taxable'
        );
      case 'refund':
        return (
          (policy.defaultSalesClassification as VATClassification) || 'taxable'
        );
      case 'fee':
        return (
          (policy.defaultFeeClassification as VATClassification) || 'input_vat'
        );
      case 'settlement':
      case 'bank_credit':
      case 'bank_debit':
        return 'not_applicable';
      case 'chargeback':
        return 'out_of_scope';
      default:
        return 'review_required';
    }
  }

  /**
   * Applies VAT classification to an import record.
   * If classification is already set, validates it. If not set, assigns default.
   * Returns the classification and computed VAT amount (using pesa, not Number).
   * Never invents a classification — unknown → review_required.
   */
  async classifyRecord(recordName: string): Promise<{
    classification: VATClassification;
    vatAmount: Money;
  }> {
    const record = await this.fyo.db.get(
      ModelNameEnum.DuhGoodsImportRecord,
      recordName
    );
    if (!record) {
      throw new Error(`Import record ${recordName} not found`);
    }

    const policy = await this.fyo.doc
      .getDoc(ModelNameEnum.DuhGoodsVATPolicy)
      .catch(() => null);
    if (!policy || !policy.enabled) {
      return {
        classification: 'not_applicable',
        vatAmount: this.fyo.pesa(0),
      };
    }

    const existing = record.vatClassification as VATClassification | undefined;
    const classification =
      existing ||
      (await this.getDefaultClassification(record.transactionType as string));

    // Use source-supplied tax amount if present (even if zero).
    // Never calculate VAT from gross — a zero-tax source record may be
    // legitimately zero-rated or exempt.  Only mark review_required when
    // the tax field is entirely absent AND the classification is taxable.
    const taxFieldPresent = record.taxes != null;
    const taxes = taxFieldPresent
      ? this.fyo.pesa(String(record.taxes))
      : this.fyo.pesa(0);

    const vatAmount = taxes;
    if (
      !taxFieldPresent &&
      (classification === 'taxable' ||
        classification === 'output_vat' ||
        classification === 'input_vat')
    ) {
      // Source did not supply a tax amount for a taxable record — flag for review.
      return { classification: 'review_required', vatAmount: this.fyo.pesa(0) };
    }

    return { classification, vatAmount };
  }

  /**
   * Computes a VAT period summary for a date range.
   * Reads all accepted reconciliation evidence for the period.
   * Never guesses a missing classification — always flags review_required.
   */
  async getPeriodSummary(
    periodStart: Date,
    periodEnd: Date
  ): Promise<VATPeriodSummary> {
    const records = await this.fyo.db.getAll(
      ModelNameEnum.DuhGoodsImportRecord,
      {
        filters: { status: ['in', ['reconciled', 'pending']] },
        fields: [
          'name',
          'transactionType',
          'transactionDate',
          'currency',
          'grossAmount',
          'taxes',
          'vatClassification',
          'vatAmount',
        ],
      }
    );

    const policy = await this.fyo.doc
      .getDoc(ModelNameEnum.DuhGoodsVATPolicy)
      .catch(() => null);
    const pesa = this.fyo.pesa.bind(this.fyo);

    let outputVAT = pesa(0);
    let inputVAT = pesa(0);
    const lineItems: VATLineItem[] = [];
    let reviewRequired = 0;
    const exceptions: string[] = [];

    for (const r of records) {
      const date = r.transactionDate as Date;
      if (!date || date < periodStart || date > periodEnd) continue;

      const classification =
        (r.vatClassification as VATClassification) || 'review_required';
      if (classification === 'review_required') {
        reviewRequired++;
        exceptions.push(
          `Record ${String(r.name)}: VAT classification requires human review`
        );
      }
      if (
        classification === 'not_applicable' ||
        classification === 'exempt' ||
        classification === 'out_of_scope'
      ) {
        continue;
      }

      const taxes = r.taxes != null ? pesa(String(r.taxes)) : null;
      const gross = pesa(String(r.grossAmount ?? 0));
      // Use stored vatAmount if present; else fall back to source taxes.
      // Never calculate from gross — that fabricates a tax fact.
      let vatAmount = r.vatAmount != null ? pesa(String(r.vatAmount)) : pesa(0);
      if (vatAmount.isZero() && taxes && !taxes.isZero()) vatAmount = taxes;

      lineItems.push({
        recordName: r.name as string,
        transactionType: r.transactionType as string,
        transactionDate: date,
        currency: r.currency as string,
        grossAmount: gross,
        taxes: taxes ?? pesa(0),
        vatClassification: classification,
        vatAmount,
      });

      if (classification === 'output_vat' || classification === 'taxable') {
        outputVAT = outputVAT.add(vatAmount);
      } else if (
        classification === 'input_vat' ||
        classification === 'recoverable_vat'
      ) {
        inputVAT = inputVAT.add(vatAmount);
      }
    }

    const netVATPayable = outputVAT.sub(inputVAT);

    return {
      periodStart,
      periodEnd,
      outputVAT,
      inputVAT,
      netVATPayable,
      lineItems,
      reviewRequired,
      exceptions,
    };
  }

  /**
   * Updates the VAT classification on an import record.
   * Only permitted values are accepted; 'review_required' is a valid human decision.
   */
  async setClassification(
    recordName: string,
    classification: VATClassification,
    reviewNote?: string
  ): Promise<void> {
    const VALID: VATClassification[] = [
      'taxable',
      'zero_rated',
      'exempt',
      'out_of_scope',
      'input_vat',
      'output_vat',
      'recoverable_vat',
      'non_recoverable_vat',
      'review_required',
      'not_applicable',
    ];
    if (!VALID.includes(classification)) {
      throw new Error(`Invalid VAT classification: ${classification}`);
    }
    const doc = await this.fyo.doc.getDoc(
      ModelNameEnum.DuhGoodsImportRecord,
      recordName
    );
    await doc.setMultiple({
      vatClassification: classification,
      ...(reviewNote !== undefined ? { vatReviewNote: reviewNote } : {}),
    });
    await doc.sync();
  }
}
