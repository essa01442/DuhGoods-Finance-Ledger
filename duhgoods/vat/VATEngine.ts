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
    const policy = await this.fyo.doc.getDoc(
      ModelNameEnum.DuhGoodsVATPolicy
    ).catch(() => null);
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

    const policy = await this.fyo.doc.getDoc(
      ModelNameEnum.DuhGoodsVATPolicy
    ).catch(() => null);
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

    const taxes = this.fyo.pesa(String(record.taxes ?? 0));
    let vatAmount = taxes;
    if (taxes.isZero()) {
      const gross = this.fyo.pesa(String(record.grossAmount ?? 0));
      const rate = (policy.standardRate as number) ?? 15;
      if (
        classification === 'taxable' ||
        classification === 'output_vat' ||
        classification === 'input_vat'
      ) {
        vatAmount = gross.mul(rate).div(100);
      } else {
        vatAmount = this.fyo.pesa(0);
      }
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

    const policy = await this.fyo.doc.getDoc(
      ModelNameEnum.DuhGoodsVATPolicy
    ).catch(() => null);
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
          `Record ${r.name}: VAT classification requires human review`
        );
      }
      if (
        classification === 'not_applicable' ||
        classification === 'exempt' ||
        classification === 'out_of_scope'
      ) {
        continue;
      }

      const taxes = pesa(String(r.taxes ?? 0));
      const gross = pesa(String(r.grossAmount ?? 0));
      const rate = (policy?.standardRate as number) ?? 15;
      let vatAmount =
        r.vatAmount != null ? pesa(String(r.vatAmount)) : pesa(0);
      if (vatAmount.isZero() && !taxes.isZero()) vatAmount = taxes;
      if (vatAmount.isZero() && (classification === 'taxable' || classification === 'output_vat' || classification === 'input_vat')) {
        vatAmount = gross.mul(rate).div(100);
      }

      lineItems.push({
        recordName: r.name as string,
        transactionType: r.transactionType as string,
        transactionDate: date,
        currency: r.currency as string,
        grossAmount: gross,
        taxes,
        vatClassification: classification,
        vatAmount,
      });

      if (
        classification === 'output_vat' ||
        classification === 'taxable'
      ) {
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
