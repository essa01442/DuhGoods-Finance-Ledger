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
  private static readonly postingPromises = new Map<string, Promise<string>>();

  /**
   * GL (JournalEntry) posting is single-currency in Frappe Books. Every
   * currency is kept in its own, unconverted amount (governing rule: no FX
   * conversion, ever). When evidence currency differs from the system's
   * configured currency, GL posting is skipped by default — the line is
   * recorded as 'native_currency_not_posted' rather than thrown away or
   * converted. Reports read DuhGoodsImportRecord directly and never depend
   * on this flag or on GL posting having happened.
   */
  private static readonly glPostingEnabledForForeignCurrency = false;

  constructor(
    private readonly fyo: Fyo,
    private readonly accounts: DuhGoodsAccountMapping
  ) {}

  async post(matchName: string): Promise<string> {
    const active =
      DuhGoodsAccountingPostingService.postingPromises.get(matchName);
    if (active) return active;
    const posting = this.postInternal(matchName);
    DuhGoodsAccountingPostingService.postingPromises.set(matchName, posting);
    try {
      return await posting;
    } finally {
      DuhGoodsAccountingPostingService.postingPromises.delete(matchName);
    }
  }

  private async postInternal(matchName: string): Promise<string> {
    const existing = await this.findPosting(matchName);
    if (existing) {
      if (
        existing.status === 'posted' ||
        existing.status === 'native_currency_not_posted'
      )
        return existing.name as string;
      // Existing non-exception row in 'reserving' state: attempt crash-recovery.
      try {
        return await this.resume(existing);
      } catch (error) {
        if (error instanceof PostingException) {
          // Transition the stranded 'reserving' row to 'exception'; no row
          // stays stuck in 'reserving' and the failure is fully auditable.
          await this.markReservationFailed(existing, error);
          throw new Error(error.message);
        }
        throw error;
      }
    }

    // No active (non-exception) posting row exists.
    // Exception rows (from prior failed attempts) are preserved as historical
    // evidence and a fresh posting lifecycle row is created below.
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
      const date = latestDate(evidence);
      if (!date)
        throw new PostingException(
          'missing_fact',
          'Evidence transaction dates are required'
        );
      const postingType = relation(evidence);
      const key = `${matchName}:${String(match.leftEvidenceHash)}:${String(
        match.rightEvidenceHash
      )}`;
      const reservation = this.fyo.doc.getNewDoc(
        ModelNameEnum.DuhGoodsAccountingPosting
      );

      if (this.requiresGlPostingSkip(evidence)) {
        await reservation.setMultiple({
          reconciliationMatch: matchName,
          idempotencyKey: key,
          postingType,
          status: 'native_currency_not_posted',
          evidenceSnapshot: evidenceSnapshot(evidence),
          accountSnapshot: JSON.stringify(this.accounts),
          auditHistory: JSON.stringify([
            {
              action: 'native_currency_not_posted',
              at: new Date().toISOString(),
            },
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
        return reservation.name as string;
      }

      const lines = this.buildLines(postingType, evidence);
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

      const referenceNumber = `DuhGoods:${matchName}`;
      let journal = await this.findJournal(referenceNumber);
      if (!journal) {
        journal = this.fyo.doc.getNewDoc(ModelNameEnum.JournalEntry);
        await journal.setMultiple({
          entryType: 'Journal Entry',
          date,
          referenceNumber,
          referenceDate: date,
          userRemark: `DuhGoods accepted reconciliation ${matchName}`,
          accounts: lines.map((line) => ({
            account: line.account,
            debit: line.debit,
            credit: line.credit,
          })),
        });
        try {
          await journal.sync();
        } catch (error) {
          if (!isDuplicateJournal(error)) throw error;
          journal = await this.findJournal(referenceNumber);
          if (!journal) throw error;
        }
      }
      await reservation.set('journalEntry', journal.name as string);
      await reservation.sync();
      if (!journal.submitted) await journal.submit();
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
    // journal.cancel() marks the JournalEntry as cancelled and creates reverse
    // AccountingLedgerEntries via afterCancel().  There is no separate reversal
    // JournalEntry — reversalJournalEntry is intentionally left unset.
    await journal.cancel();
    await posting.setMultiple({
      status: 'reversed',
      auditHistory: appendAudit(posting.auditHistory as string, 'reversed'),
    });
    await posting.sync();
  }

  /** Returns the first active (non-exception) posting row for a match. */
  private async findPosting(
    matchName: string
  ): Promise<Record<string, unknown> | undefined> {
    return (
      await this.fyo.db.getAll(ModelNameEnum.DuhGoodsAccountingPosting, {
        filters: {
          reconciliationMatch: matchName,
          status: ['!=', 'exception'] as unknown as string,
        },
        fields: [
          'name',
          'status',
          'exceptionMessage',
          'reconciliationMatch',
          'journalEntry',
        ],
        limit: 1,
      })
    )[0];
  }

  private async resume(posting: Record<string, unknown>): Promise<string> {
    const journal = posting.journalEntry
      ? await this.fyo.doc.getDoc(
          ModelNameEnum.JournalEntry,
          posting.journalEntry as string
        )
      : await this.findJournal(
          `DuhGoods:${String(posting.reconciliationMatch ?? '')}`
        );
    if (!journal) {
      // The reservation was persisted before any JournalEntry existed; retry safely.
      const matchName = posting.reconciliationMatch as string;
      const reservation = await this.fyo.doc.getDoc(
        ModelNameEnum.DuhGoodsAccountingPosting,
        posting.name as string,
        { skipDocumentCache: true }
      );
      const match = await this.fyo.db.get(
        ModelNameEnum.DuhGoodsReconciliationMatch,
        matchName
      );
      // Re-validate evidence — throws PostingException on superseded / invalid evidence.
      const evidence = await this.getCurrentEvidence(match);
      const resumeDate = latestDate(evidence);
      if (!resumeDate)
        throw new PostingException(
          'missing_fact',
          'Evidence transaction dates are required'
        );
      if (this.requiresGlPostingSkip(evidence)) {
        await reservation.setMultiple({
          status: 'native_currency_not_posted',
          auditHistory: appendAudit(
            reservation.auditHistory as string,
            'native_currency_not_posted'
          ),
        });
        await reservation.sync();
        return reservation.name as string;
      }
      const postingType = relation(evidence);
      const lines = this.buildLines(postingType, evidence);
      const referenceNumber = `DuhGoods:${matchName}`;
      const recoveredJournal = this.fyo.doc.getNewDoc(
        ModelNameEnum.JournalEntry
      );
      await recoveredJournal.setMultiple({
        entryType: 'Journal Entry',
        date: resumeDate,
        referenceNumber,
        referenceDate: resumeDate,
        userRemark: `DuhGoods accepted reconciliation ${matchName}`,
        accounts: lines,
      });
      try {
        await recoveredJournal.sync();
      } catch (error) {
        if (!isDuplicateJournal(error)) throw error;
        return this.resume(posting);
      }
      await reservation.set('journalEntry', recoveredJournal.name as string);
      await reservation.sync();
      await recoveredJournal.submit();
      await reservation.setMultiple({
        status: 'posted',
        auditHistory: appendAudit(reservation.auditHistory as string, 'posted'),
      });
      await reservation.sync();
      return reservation.name as string;
    }
    if (!journal.submitted) await journal.submit();
    const reservation = await this.fyo.doc.getDoc(
      ModelNameEnum.DuhGoodsAccountingPosting,
      posting.name as string,
      { skipDocumentCache: true }
    );
    await reservation.setMultiple({
      status: 'posted',
      journalEntry: journal.name,
      auditHistory: appendAudit(reservation.auditHistory as string, 'posted'),
    });
    await reservation.sync();
    return reservation.name as string;
  }

  /**
   * Transition a stranded 'reserving' row to 'exception'.
   * Called when crash-recovery revalidation fails with a PostingException so
   * that no row is left stuck in 'reserving'.  The original posting facts
   * (idempotencyKey, postingType, evidenceSnapshot) are preserved immutably.
   */
  private async markReservationFailed(
    posting: Record<string, unknown>,
    error: PostingException
  ): Promise<void> {
    const reservation = await this.fyo.doc.getDoc(
      ModelNameEnum.DuhGoodsAccountingPosting,
      posting.name as string,
      { skipDocumentCache: true }
    );
    await reservation.setMultiple({
      status: 'exception',
      exceptionCode: error.code,
      exceptionMessage: error.message,
      auditHistory: appendAudit(
        reservation.auditHistory as string,
        `exception:${error.code}`
      ),
    });
    await reservation.sync();
  }

  private async findJournal(referenceNumber: string) {
    const rows = await this.fyo.db.getAll(ModelNameEnum.JournalEntry, {
      filters: { referenceNumber },
      fields: ['name'],
      limit: 1,
    });
    if (!rows[0]) return;
    return this.fyo.doc.getDoc(
      ModelNameEnum.JournalEntry,
      rows[0].name as string
    );
  }

  /**
   * True when this evidence set cannot be posted to the (single-currency) GL
   * without converting a foreign-currency amount. Governing rule: never
   * convert. Evidence is posted to the GL only when its currency already
   * matches the system's configured currency, or when GL posting for
   * foreign currency has been explicitly opted into.
   */
  private requiresGlPostingSkip(evidence: Evidence[]): boolean {
    if (DuhGoodsAccountingPostingService.glPostingEnabledForForeignCurrency)
      return false;
    const systemCurrency = this.fyo.singles.SystemSettings?.currency;
    if (!systemCurrency) return false;
    return evidence.some(
      (row) => !!row.currency && row.currency !== systemCurrency
    );
  }

  private async exception(
    matchName: string,
    code: string,
    message: string
  ): Promise<string> {
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
      // Another concurrent call already recorded the exception; ignore the
      // duplicate and surface the error message to the caller.
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
    shipping: moneyFact(facts.shipping_total, fyo),
    discount: moneyFact(facts.discount_total, fyo),
  };
}
function moneyFact(value: unknown, fyo: Fyo): Money | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' && typeof value !== 'number')
    throw new PostingException(
      'missing_fact',
      'Shipping and discount facts must be numeric'
    );
  // Always convert to string to prevent JS Number precision loss on JSON-parsed
  // numeric values (e.g. shipping_total: 10.25 from a WooCommerce JSON export).
  return fyo.pesa(String(value));
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
function isDuplicateJournal(error: unknown): boolean {
  return (
    error instanceof Error &&
    /UNIQUE constraint failed.*JournalEntry.referenceNumber/i.test(
      error.message
    )
  );
}
function isReversalClaimError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes('DuhGoods accounting reversal already claimed')
  );
}
function evidenceSnapshot(evidence: Evidence[]): string {
  return JSON.stringify({
    evidence: evidence.map((item) => ({
      name: item.name,
      evidenceHash: item.evidenceHash,
      evidenceVersion: item.evidenceVersion,
      transactionType: item.transactionType,
      currency: item.currency,
      grossAmount: item.grossAmount?.store,
      netAmount: item.netAmount?.store,
      fees: item.fees?.store,
      taxes: item.taxes?.store,
      rawData: item.rawData,
    })),
  });
}
