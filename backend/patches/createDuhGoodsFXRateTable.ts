import { DatabaseManager } from '../database/manager';

/**
 * Version 0.38.5 — DuhGoods FX Rate evidence table.
 *
 * DuhGoodsFXRate stores immutable, locally-supplied exchange rate evidence.
 * No online FX APIs are used; rates come only from locally imported files
 * or explicit manual user entry.
 *
 * The table is created by db.migrate() in the schema-sync step.
 * This patch adds a unique index on (effectiveDate, baseCurrency, quoteCurrency)
 * to prevent duplicate rate evidence for the same currency pair on the same day,
 * and an index on (baseCurrency, quoteCurrency, effectiveDate) for fast lookup.
 */
async function execute(dm: DatabaseManager): Promise<void> {
  const knex = dm.db!.knex!;
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_dgfxr_pair_date
      ON DuhGoodsFXRate (effectiveDate, baseCurrency, quoteCurrency)
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_dgfxr_lookup
      ON DuhGoodsFXRate (baseCurrency, quoteCurrency, effectiveDate)
  `);
}

export default { execute };
