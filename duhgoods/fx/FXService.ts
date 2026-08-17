import type { Fyo } from 'fyo';
import { p } from 'pesa';
import type { Money } from 'pesa';
import { ModelNameEnum } from 'models/types';
import { computeEvidenceHash } from '../evidence/EvidenceManager';

export interface FXRateEvidence {
  name: string;
  effectiveDate: Date;
  baseCurrency: string;
  quoteCurrency: string;
  /** Exact decimal string — NEVER a JS number (binary floats corrupt rates). */
  rate: string;
  sourceDescription: string;
  origin: string;
  /** True when this rate was derived by inverting a stored inverse-pair rate. */
  derived?: boolean;
}

export interface FXConversionResult {
  sourceAmount: Money;
  sourceCurrency: string;
  functionalAmount: Money;
  functionalCurrency: string;
  /** Exact decimal string of the rate actually applied. */
  rate: string;
  rateEvidenceName: string;
  rateEffectiveDate: Date;
  /** True when the applied rate was derived from an inverse-pair record. */
  rateDerived?: boolean;
}

export interface FXMissingRateException {
  sourceCurrency: string;
  functionalCurrency: string;
  transactionDate: Date;
  message: string;
}

/** Precision (decimal places) used for exact rate arithmetic. */
const RATE_PRECISION = 18;

/** Strict decimal grammar — rejects scientific notation, hex, NaN, Infinity. */
const DECIMAL_RE = /^-?(\d+\.?\d*|\.\d+)$/;

/**
 * Normalizes an unknown value into an exact decimal string.
 * Returns null when the value is not a finite plain decimal.
 * Numbers are converted via toString() and must still satisfy the grammar —
 * scientific-notation output (e.g. 1e-7) is rejected.
 */
export function toDecimalString(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const str = String(value).trim();
  if (!DECIMAL_RE.test(str)) return null;
  return str;
}

/**
 * Exact inverse of a decimal rate: 1 / rate at RATE_PRECISION decimal places.
 * Uses PreciseNumber (arbitrary-precision decimal) — never JS float division.
 */
export function invertRate(rate: string): string {
  return p('1', RATE_PRECISION).div(p(rate, RATE_PRECISION)).toString();
}

/**
 * Offline FX service.
 *
 * Exchange rates come ONLY from locally imported files or explicit manual
 * user entry. No online FX APIs are used. A missing rate ALWAYS produces a
 * review exception — the service NEVER invents or interpolates a rate.
 */
export class FXService {
  constructor(private readonly fyo: Fyo) {}

  /**
   * Finds the best available rate for a currency pair on a given date.
   * "Best" = the most recent rate on or before the transaction date.
   * Returns null (never throws) when no rate is available.
   */
  async findRate(
    baseCurrency: string,
    quoteCurrency: string,
    transactionDate: Date
  ): Promise<FXRateEvidence | null> {
    if (baseCurrency === quoteCurrency) {
      return {
        name: '__identity__',
        effectiveDate: transactionDate,
        baseCurrency,
        quoteCurrency,
        rate: '1',
        sourceDescription: 'Identity rate (same currency)',
        origin: 'manual_entry',
      };
    }

    const dateStr = transactionDate.toISOString().slice(0, 10);
    const rows = await this.fyo.db.getAll(ModelNameEnum.DuhGoodsFXRate, {
      filters: {
        baseCurrency,
        quoteCurrency,
        effectiveDate: ['<=', dateStr],
      },
      fields: ['name', 'effectiveDate', 'baseCurrency', 'quoteCurrency', 'rate', 'sourceDescription', 'origin'],
      orderBy: 'effectiveDate',
      order: 'desc',
      limit: 1,
    });

    if (rows.length === 0) {
      // Try inverse pair
      const inverseRows = await this.fyo.db.getAll(ModelNameEnum.DuhGoodsFXRate, {
        filters: {
          baseCurrency: quoteCurrency,
          quoteCurrency: baseCurrency,
          effectiveDate: ['<=', dateStr],
        },
        fields: ['name', 'effectiveDate', 'baseCurrency', 'quoteCurrency', 'rate', 'sourceDescription', 'origin'],
        orderBy: 'effectiveDate',
        order: 'desc',
        limit: 1,
      });
      if (inverseRows.length > 0) {
        const r = inverseRows[0];
        const storedRate = toDecimalString(r.rate);
        if (!storedRate || p(storedRate, RATE_PRECISION).isZero()) {
          return null;
        }
        return {
          name: r.name as string,
          effectiveDate: r.effectiveDate as Date,
          baseCurrency,
          quoteCurrency,
          rate: invertRate(storedRate),
          sourceDescription: `Derived (inverse of): ${r.sourceDescription}`,
          origin: r.origin as string,
          derived: true,
        };
      }
      return null;
    }

    const r = rows[0];
    const rate = toDecimalString(r.rate);
    if (!rate) return null;
    return {
      name: r.name as string,
      effectiveDate: r.effectiveDate as Date,
      baseCurrency: r.baseCurrency as string,
      quoteCurrency: r.quoteCurrency as string,
      rate,
      sourceDescription: r.sourceDescription as string,
      origin: r.origin as string,
    };
  }

  /**
   * Converts a source-currency amount to the functional currency.
   * Returns null (never fabricates) when no rate evidence is available.
   */
  async convert(
    sourceAmount: Money,
    sourceCurrency: string,
    functionalCurrency: string,
    transactionDate: Date
  ): Promise<FXConversionResult | FXMissingRateException> {
    const evidence = await this.findRate(
      sourceCurrency,
      functionalCurrency,
      transactionDate
    );

    if (!evidence) {
      return {
        sourceCurrency,
        functionalCurrency,
        transactionDate,
        message: `No FX rate evidence found for ${sourceCurrency}/${functionalCurrency} on or before ${transactionDate.toISOString().slice(0, 10)}. Import a local FX rate file or enter a rate manually.`,
      };
    }

    const pesa = this.fyo.pesa.bind(this.fyo);
    const functionalAmount = sourceAmount.mul(pesa(evidence.rate));

    return {
      sourceAmount,
      sourceCurrency,
      functionalAmount,
      functionalCurrency,
      rate: evidence.rate,
      rateEvidenceName: evidence.name,
      rateEffectiveDate: evidence.effectiveDate,
      rateDerived: evidence.derived,
    };
  }

  isMissingRateException(
    result: FXConversionResult | FXMissingRateException
  ): result is FXMissingRateException {
    return 'message' in result;
  }

  /**
   * Applies FX conversion to an import record.
   * If a rate is available, stores the functionalCurrencyAmount and fxRate.
   * If not, sets fxReviewNote with the reason — never fabricates a conversion.
   */
  async applyToRecord(
    recordName: string,
    functionalCurrency: string
  ): Promise<{ ok: boolean; message?: string }> {
    const record = await this.fyo.db.get(
      ModelNameEnum.DuhGoodsImportRecord,
      recordName
    );
    if (!record) {
      return { ok: false, message: `Record ${recordName} not found` };
    }

    const sourceCurrency = record.currency as string;
    if (sourceCurrency === functionalCurrency) {
      const doc = await this.fyo.doc.getDoc(
        ModelNameEnum.DuhGoodsImportRecord,
        recordName
      );
      await doc.setMultiple({
        functionalCurrencyAmount: doc.netAmount as never,
        fxRate: '1',
        fxRateRef: undefined,
      });
      await doc.sync();
      return { ok: true };
    }

    const netAmount = this.fyo.pesa(String(record.netAmount ?? 0));
    const result = await this.convert(
      netAmount,
      sourceCurrency,
      functionalCurrency,
      record.transactionDate as Date
    );

    const doc = await this.fyo.doc.getDoc(
      ModelNameEnum.DuhGoodsImportRecord,
      recordName
    );

    if (this.isMissingRateException(result)) {
      await doc.setMultiple({
        fxReviewNote: result.message,
        vatClassification: (doc.vatClassification as string) || 'review_required',
      });
      await doc.sync();
      return { ok: false, message: result.message };
    }

    await doc.setMultiple({
      functionalCurrencyAmount: result.functionalAmount as never,
      fxRate: result.rate,
      fxRateRef: result.rateEvidenceName === '__identity__' ? undefined : result.rateEvidenceName,
      fxReviewNote: undefined,
    });
    await doc.sync();
    return { ok: true };
  }

  /**
   * Stores a new FX rate from manual entry.
   * Idempotent: if a rate already exists for the same pair/date, skips.
   * Never overwrites existing evidence — returns the existing record name instead.
   */
  async storeManualRate(opts: {
    effectiveDate: Date;
    baseCurrency: string;
    quoteCurrency: string;
    /** Exact decimal string (plain number input is normalized and validated). */
    rate: string | number;
    sourceDescription: string;
  }): Promise<{ name: string; created: boolean }> {
    const rate = toDecimalString(opts.rate);
    if (!rate || !p(rate, RATE_PRECISION).isPositive()) {
      throw new Error('FX rate must be a positive exact decimal');
    }
    if (!opts.baseCurrency || !opts.quoteCurrency) {
      throw new Error('FX rate requires both base and quote currency');
    }
    if (!opts.sourceDescription?.trim()) {
      throw new Error('FX rate requires a source description');
    }

    const dateStr = opts.effectiveDate.toISOString().slice(0, 10);
    const evidenceHash = computeEvidenceHash({
      effectiveDate: dateStr,
      baseCurrency: opts.baseCurrency,
      quoteCurrency: opts.quoteCurrency,
      rate,
      sourceDescription: opts.sourceDescription,
    });

    const existing = await this.fyo.db.getAll(ModelNameEnum.DuhGoodsFXRate, {
      filters: {
        effectiveDate: dateStr,
        baseCurrency: opts.baseCurrency,
        quoteCurrency: opts.quoteCurrency,
      },
      fields: ['name'],
      limit: 1,
    });

    if (existing.length > 0) {
      return { name: existing[0].name as string, created: false };
    }

    const doc = this.fyo.doc.getNewDoc(ModelNameEnum.DuhGoodsFXRate);
    await doc.setMultiple({
      effectiveDate: opts.effectiveDate,
      baseCurrency: opts.baseCurrency,
      quoteCurrency: opts.quoteCurrency,
      rate,
      sourceDescription: opts.sourceDescription,
      origin: 'manual_entry',
      evidenceHash,
    });
    await doc.sync();
    return { name: doc.name as string, created: true };
  }

  /**
   * Imports FX rates from a simple JSON file.
   * Expected format:
   * [{ "date": "YYYY-MM-DD", "base": "USD", "quote": "SAR", "rate": 3.75, "source": "..." }, ...]
   * Idempotent — existing rates for the same pair/date are skipped.
   */
  async importFromJSON(
    content: string,
    importSourceId?: string
  ): Promise<{ imported: number; skipped: number; errors: string[] }> {
    let rows: unknown[];
    try {
      rows = JSON.parse(content);
      if (!Array.isArray(rows)) {
        throw new Error('Expected JSON array');
      }
    } catch (e) {
      throw new Error(`Invalid FX rate JSON: ${e instanceof Error ? e.message : String(e)}`);
    }

    let imported = 0;
    let skipped = 0;
    const errors: string[] = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i] as Record<string, unknown>;
      try {
        const dateStr = String(row.date ?? '');
        const base = String(row.base ?? '');
        const quote = String(row.quote ?? '');
        const rate = toDecimalString(row.rate);
        const source = String(row.source ?? 'Imported file');

        if (!dateStr.match(/^\d{4}-\d{2}-\d{2}$/)) {
          throw new Error(`Row ${i}: invalid date "${dateStr}"`);
        }
        if (!base || !quote) {
          throw new Error(`Row ${i}: base and quote currencies are required`);
        }
        if (!rate || !p(rate, RATE_PRECISION).isPositive()) {
          throw new Error(`Row ${i}: rate must be a positive exact decimal`);
        }

        const effectiveDate = new Date(dateStr + 'T00:00:00Z');
        const evidenceHash = computeEvidenceHash({ date: dateStr, base, quote, rate, source });

        const existing = await this.fyo.db.getAll(ModelNameEnum.DuhGoodsFXRate, {
          filters: { effectiveDate: dateStr, baseCurrency: base, quoteCurrency: quote },
          fields: ['name'],
          limit: 1,
        });

        if (existing.length > 0) {
          skipped++;
          continue;
        }

        const doc = this.fyo.doc.getNewDoc(ModelNameEnum.DuhGoodsFXRate);
        await doc.setMultiple({
          effectiveDate,
          baseCurrency: base,
          quoteCurrency: quote,
          rate,
          sourceDescription: source,
          origin: 'imported_file',
          evidenceHash,
          ...(importSourceId ? { importSource: importSourceId } : {}),
        });
        await doc.sync();
        imported++;
      } catch (e) {
        errors.push(e instanceof Error ? e.message : String(e));
      }
    }

    return { imported, skipped, errors };
  }
}
