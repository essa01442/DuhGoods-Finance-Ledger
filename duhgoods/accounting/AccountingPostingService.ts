import type { Fyo } from 'fyo';
import { ModelNameEnum } from 'models/types';
import type { Money } from 'pesa';

export type DuhGoodsAccountMapping = {
  pspClearing: string;
  bank: string;
  sales: string;
  refunds: string;
  chargebacks: string;
  feeExpense?: string;
  taxPayable?: string;
  shippingRevenue?: string;
  discounts?: string;
};

type Evidence = {
  name: string;
  sourceType?: string;
  transactionType?: string;
  transactionDate?: Date;
  currency?: string;
  grossAmount?: Money;
  fees?: Money;
  taxes?: Money;
  netAmount?: Money;
  status?: string;
  identityKey?: string;
  evidenceVersion?: number;
  evidenceHash?: string;
  rawData?: string;
};

type Line = { account: string; debit: Money; credit: Money };

/** File-driven conversion of accepted reconciliation evidence into Journal Entries. */
export class DuhGoodsAccountingPostingService {
  constructor(
    private readonly fyo: Fyo,
    private readonly accounts: DuhGoodsAccountMapping
  ) {}

  async post(matchName: string): Promise<string> {
    const existing = await this.findPosting(matchName);
    if (existing) {
      if (existing.status === 'exception')
        throw new Error(existing.exceptionMessage as string);
      return existing.name as string;
    }

    const match = await this.fyo.db.get(
      ModelNameEnum.DuhGoodsReconciliationMatch,
      matchName
    );
    if (match.status !== 'accepted')
      return this.exception(
        matchName,
        'unaccepted_match',
        'Only accepted reconciliations can be posted'
      );

    try {
      const evidence = await this.getCurrentEvidence(match);
      const postingType = relation(evidence);
      const lines = this.buildLines(postingType, evidence);
      const date = latestDate(evidence);
      if (!date)
        throw new PostingException(
          'missing_fact',
          'Evidence transaction dates are required'
        );
      const key = `${matchName}:${String(match.leftEvidenceHash)}:${String(
        match.rightEvidenceHash
      )}`;
      const reservation = this.fyo.doc.getNewDoc(
        ModelNameEnum.DuhGoodsAccountingPosting
      );
      await reservation.setMultiple({
        reconciliationMatch: matchName,
        idempotencyKey: key,
        postingType,
        status: 'reserving',
        evidenceSnapshot: evidenceSnapshot(evidence),
        accountSnapshot: JSON.stringify(this.accounts),
        auditHistory: JSON.stringify([
          { action: 'reserved', at: new Date().toISOString() },
        ]),
      });
      try {
        await reservation.sync();
      } catch (error) {
        if (!isDuplicatePosting(error)) throw error;
        const concurrent = await this.findPosting(matchName);
        if (concurrent) return concurrent.name as string;
        throw error;
      }

      const journal = this.fyo.doc.getNewDoc(ModelNameEnum.JournalEntry);
      await journal.setMultiple({
        entryType: 'Journal Entry',
        date,
        referenceNumber: `DuhGoods:${matchName}`,
        referenceDate: date,
        userRemark: `DuhGoods accepted reconciliation ${matchName}`,
        accounts: lines.map((line) => ({
          account: line.account,
          debit: line.debit,
          credit: line.credit,
        })),
      });
      await journal.sync();
      await journal.submit();

      await reservation.setMultiple({
        status: 'posted',
        journalEntry: journal.name,
        auditHistory: appendAudit(reservation.auditHistory as string, 'posted'),
      });
      await reservation.sync();
      return reservation.name as string;
    } catch (error) {
      if (error instanceof PostingException)
        return this.exception(matchName, error.code, error.message);
      throw error;
    }
  }

  async reverse(postingName: string): Promise<void> {
    const posting = await this.fyo.doc.getDoc(
      ModelNameEnum.DuhGoodsAccountingPosting,
      postingName,
      { skipDocumentCache: true }
    );
    if (posting.status === 'reversed' || posting.status === 'reversing') return;
    if (posting.status !== 'posted')
      throw new Error(
        'Only posted DuhGoods accounting postings can be reversed'
      );
    await posting.set('status', 'reversing');
    try {
      await posting.sync();
    } catch (error) {
      if (isReversalClaimError(error)) return;
      throw error;
    }
    const journal = await this.fyo.doc.getDoc(
      ModelNameEnum.JournalEntry,
      posting.journalEntry as string
    );
    await journal.cancel();
    await posting.setMultiple({
      status: 'reversed',
      reversalJournalEntry: posting.journalEntry as string,
      auditHistory: appendAudit(posting.auditHistory as string, 'reversed'),
    });
    await posting.sync();
  }

  private async findPosting(
    matchName: string
  ): Promise<Record<string, unknown> | undefined> {
    return (
      await this.fyo.db.getAll(ModelNameEnum.DuhGoodsAccountingPosting, {
        filters: { reconciliationMatch: matchName },
        fields: ['name', 'status', 'exceptionMessage'],
        limit: 1,
      })
    )[0];
  }

  private async exception(
    matchName: string,
    code: string,
    message: string
  ): Promise<string> {
    const existing = await this.findPosting(matchName);
    if (existing) throw new Error(existing.exceptionMessage as string);
    const posting = this.fyo.doc.getNewDoc(
      ModelNameEnum.DuhGoodsAccountingPosting
    );
    await posting.setMultiple({
      reconciliationMatch: matchName,
      idempotencyKey: `exception:${matchName}`,
      postingType: 'exception',
      status: 'exception',
      evidenceSnapshot: '{}',
      accountSnapshot: JSON.stringify(this.accounts),
      auditHistory: JSON.stringify([
        { action: 'exception', code, at: new Date().toISOString() },
      ]),
      exceptionCode: code,
      exceptionMessage: message,
    });
    try {
      await posting.sync();
    } catch (error) {
      if (!isDuplicatePosting(error)) throw error;
    }
    throw new Error(message);
  }

  private async getCurrentEvidence(
    match: Record<string, unknown>
  ): Promise<Evidence[]> {
    const rows = (await Promise.all(
      [match.leftRecord, match.rightRecord].map((name) =>
        this.fyo.db.get(ModelNameEnum.DuhGoodsImportRecord, name as string)
      )
    )) as Evidence[];
    if (rows.length !== 2)
      throw new PostingException(
        'missing_fact',
        'Accepted reconciliation evidence is missing'
      );
    const hashes = new Map(rows.map((row) => [row.name, row.evidenceHash]));
    if (
      hashes.get(match.leftRecord as string) !== match.leftEvidenceHash ||
      hashes.get(match.rightRecord as string) !== match.rightEvidenceHash
    )
      throw new PostingException(
        'superseded_evidence',
        'Accepted reconciliation evidence has changed'
      );
    for (const row of rows) {
      if (row.status === 'exception')
        throw new PostingException(
          'invalid_evidence',
          'Exception evidence cannot be posted'
        );
      if (!row.identityKey)
        throw new PostingException(
          'missing_fact',
          'Evidence identity is required'
        );
      const versions = await this.fyo.db.getAll(
        ModelNameEnum.DuhGoodsImportRecord,
        {
          filters: { identityKey: row.identityKey },
          fields: ['evidenceVersion', 'name'],
        }
      );
      if (
        versions.some(
          (version) =>
            Number(version.evidenceVersion) > Number(row.evidenceVersion)
        )
      )
        throw new PostingException(
          'superseded_evidence',
          'Accepted reconciliation uses superseded evidence'
        );
    }
    return rows;
  }

  private buildLines(type: string, evidence: Evidence[]): Line[] {
    const amount = economicAmount(evidence, this.fyo, type);
    if (amount.isZero())
      throw new PostingException(
        'missing_fact',
        'A non-zero evidence amount is required'
      );
    const debit = (account: string, value: Money): Line => ({
      account,
      debit: value,
      credit: this.fyo.pesa(0),
    });
    const credit = (account: string, value: Money): Line => ({
      account,
      debit: this.fyo.pesa(0),
      credit: value,
    });
    if (type === 'order_payment' || type === 'refund_refund') {
      const commercial = commercialComponents(evidence, amount, this.fyo);
      const isRefund = type === 'refund_refund';
      const sales = required(
        isRefund ? this.accounts.refunds : this.accounts.sales,
        isRefund ? 'refunds' : 'sales'
      );
      const clearing = required(this.accounts.pspClearing, 'pspClearing');
      const revenueLines = [
        isRefund
          ? debit(sales, commercial.sales)
          : credit(sales, commercial.sales),
      ];
      if (!commercial.tax.isZero())
        revenueLines.push(
          isRefund
            ? debit(
                required(this.accounts.taxPayable, 'taxPayable'),
                commercial.tax
              )
            : credit(
                required(this.accounts.taxPayable, 'taxPayable'),
                commercial.tax
              )
        );
      if (!commercial.shipping.isZero())
        revenueLines.push(
          isRefund
            ? debit(
                required(this.accounts.shippingRevenue, 'shippingRevenue'),
                commercial.shipping
              )
            : credit(
                required(this.accounts.shippingRevenue, 'shippingRevenue'),
                commercial.shipping
              )
        );
      if (!commercial.discount.isZero())
        revenueLines.push(
          isRefund
            ? credit(
                required(this.accounts.discounts, 'discounts'),
                commercial.discount
              )
            : debit(
                required(this.accounts.discounts, 'discounts'),
                commercial.discount
              )
        );
      return isRefund
        ? [...revenueLines, credit(clearing, amount)]
        : [debit(clearing, amount), ...revenueLines];
    }
    if (type === 'chargeback_bank_debit')
      return [
        debit(required(this.accounts.chargebacks, 'chargebacks'), amount),
        credit(required(this.accounts.bank, 'bank'), amount),
      ];

    const settlement = evidence.find(
      (row) => row.transactionType === 'settlement'
    )!;
    const fee = absolute(settlement.fees, this.fyo);
    const tax = absolute(settlement.taxes, this.fyo);
    const bank = amount;
    const clearing = bank.add(fee).add(tax);
    const lines = [debit(required(this.accounts.bank, 'bank'), bank)];
    if (!fee.isZero())
      lines.push(debit(required(this.accounts.feeExpense, 'feeExpense'), fee));
    if (!tax.isZero())
      lines.push(debit(required(this.accounts.taxPayable, 'taxPayable'), tax));
    lines.push(
      credit(required(this.accounts.pspClearing, 'pspClearing'), clearing)
    );
    return lines;
  }
}

class PostingException extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}
function required(value: string | undefined, name: string): string {
  if (!value)
    throw new PostingException(
      'missing_configuration',
      `Explicit account mapping "${name}" is required`
    );
  return value;
}
function absolute(value: Money | undefined, fyo: Fyo): Money {
  return value ? value.abs() : fyo.pesa(0);
}
function economicAmount(evidence: Evidence[], fyo: Fyo, type: string): Money {
  const record = evidence.find((row) =>
    type === 'order_payment'
      ? row.transactionType === 'order'
      : type === 'refund_refund'
      ? row.transactionType === 'refund'
      : row.transactionType === 'settlement' ||
        row.transactionType === 'bank_credit' ||
        row.transactionType === 'chargeback' ||
        row.transactionType === 'bank_debit'
  );
  const amount =
    type === 'order_payment'
      ? record?.grossAmount
      : record?.netAmount ?? record?.grossAmount;
  if (!amount)
    throw new PostingException(
      'missing_fact',
      `A ${type === 'order_payment' ? 'gross' : 'net'} amount is required`
    );
  return amount.abs();
}
function commercialComponents(evidence: Evidence[], amount: Money, fyo: Fyo) {
  const commerce = evidence.find(
    (row) => row.transactionType === 'order' || row.transactionType === 'refund'
  );
  if (!commerce)
    throw new PostingException(
      'missing_fact',
      'Order or refund evidence is required'
    );
  const tax = absolute(commerce.taxes, fyo);
  const raw = parseEvidenceFacts(commerce.rawData, fyo);
  const shipping = absolute(raw.shipping, fyo);
  const discount = absolute(raw.discount, fyo);
  const sales = amount.sub(tax).sub(shipping).add(discount);
  if (sales.isNegative())
    throw new PostingException(
      'missing_fact',
      'Explicit tax, shipping, and discount facts exceed the reconciled amount'
    );
  return { sales, tax, shipping, discount };
}
function parseEvidenceFacts(
  rawData: string | undefined,
  fyo: Fyo
): { shipping?: Money; discount?: Money } {
  if (!rawData) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(rawData);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new PostingException(
      'missing_fact',
      'Evidence raw data is not valid JSON'
    );
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const facts = raw as Record<string, unknown>;
  return {
    shipping: moneyFact(facts.shippingAmount ?? facts.shipping, fyo),
    discount: moneyFact(facts.discountAmount ?? facts.discount, fyo),
  };
}
function moneyFact(value: unknown, fyo: Fyo): Money | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' && typeof value !== 'number')
    throw new PostingException(
      'missing_fact',
      'Shipping and discount facts must be numeric'
    );
  return fyo.pesa(value);
}
function relation(rows: Evidence[]): string {
  const types = new Set(
    rows.map((row) => `${row.sourceType ?? ''}:${row.transactionType ?? ''}`)
  );
  if (types.has('woocommerce:order') && types.has('psp_export:payment'))
    return 'order_payment';
  if (types.has('woocommerce:refund') && types.has('psp_export:refund'))
    return 'refund_refund';
  if (
    types.has('psp_export:settlement') &&
    types.has('bank_statement:bank_credit')
  )
    return 'settlement_bank_credit';
  if (
    types.has('psp_export:chargeback') &&
    types.has('bank_statement:bank_debit')
  )
    return 'chargeback_bank_debit';
  throw new PostingException(
    'invalid_match',
    'Accepted reconciliation has no supported posting relationship'
  );
}
function latestDate(rows: Evidence[]): Date | undefined {
  const dates = rows
    .map((row) => row.transactionDate)
    .filter((date): date is Date => date instanceof Date);
  return dates.sort((a, b) => b.getTime() - a.getTime())[0];
}
function appendAudit(history: string, action: string): string {
  const parsed: unknown = JSON.parse(history);
  if (!Array.isArray(parsed))
    throw new Error('DuhGoodsAccountingPosting: audit history is invalid');
  const entries: unknown[] = parsed;
  return JSON.stringify([...entries, { action, at: new Date().toISOString() }]);
}
function isDuplicatePosting(error: unknown): boolean {
  return (
    error instanceof Error &&
    /UNIQUE constraint failed.*DuhGoodsAccountingPosting/i.test(error.message)
  );
}
function isReversalClaimError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes('DuhGoods accounting reversal already claimed')
  );
}
function evidenceSnapshot(evidence: Evidence[]): string {
  return JSON.stringify(
    evidence.map((item) => ({
      name: item.name,
      evidenceHash: item.evidenceHash,
      evidenceVersion: item.evidenceVersion,
      transactionType: item.transactionType,
      grossAmount: item.grossAmount?.store,
      netAmount: item.netAmount?.store,
      fees: item.fees?.store,
      taxes: item.taxes?.store,
      rawData: item.rawData,
    }))
  );
}
