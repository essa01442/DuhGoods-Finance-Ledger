import { DatabaseManager } from '../database/manager';

/**
 * Version 0.38.7 — Migrate DuhGoodsFXRate.rate column from REAL to TEXT.
 *
 * The FX hardening commit changed the schema field type from Float (REAL) to
 * Data (TEXT) to prevent binary floating-point corruption of rate values.
 *
 * SQLite's ALTER TABLE RENAME COLUMN / type change is not directly supported,
 * but SQLite's flexible type affinity means TEXT values can coexist with REAL
 * columns. We explicitly UPDATE any numeric rate values to their canonical
 * string form, ensuring all rates are stored as plain decimal strings even
 * when the physical column type is REAL.
 *
 * The schema-sync step in db.migrate() will NOT change the column type for
 * existing databases (additive-only migration). This patch therefore converts
 * existing data in-place.
 *
 * Idempotent: running twice produces no additional changes.
 */
async function execute(dm: DatabaseManager): Promise<void> {
  const db = dm.db;
  if (!db) return;

  // Check if the table exists.
  const tables = db.knex
    ? await db.knex.raw(`SELECT name FROM sqlite_master WHERE type='table' AND name='DuhGoodsFXRate'`)
    : [];
  if (!tables || (Array.isArray(tables) && tables.length === 0)) return;

  // Re-cast any numeric-typed stored values to their decimal string form.
  // CAST(rate AS TEXT) in SQLite will produce '3.75' from a REAL 3.75.
  // The WHERE clause targets rows where typeof(rate) = 'real' so we only
  // touch rows that were stored under the old Float column behavior.
  if (db.knex) {
    await db.knex.raw(`
      UPDATE DuhGoodsFXRate
      SET rate = CAST(rate AS TEXT)
      WHERE typeof(rate) = 'real'
    `);
  }
}

export default { execute };
