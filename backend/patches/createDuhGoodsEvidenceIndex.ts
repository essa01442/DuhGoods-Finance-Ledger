import { DatabaseManager } from '../database/manager';

/**
 * Creates two real SQLite UNIQUE indexes on DuhGoodsImportRecord:
 *
 *   1. idx_dghir_evidence_hash  — on evidenceHash alone
 *      Prevents any two records from sharing identical evidence (import
 *      idempotency guarantee). The application-layer beforeSync() check
 *      is a TOCTOU guard; this index is the atomic safety net.
 *
 *   2. idx_dghir_identity_version — on (identityKey, evidenceVersion)
 *      Prevents concurrent creation of the same version of the same
 *      identity's evidence chain.
 *
 * Both statements use IF NOT EXISTS so the patch is fully idempotent on
 * repeated execution (e.g. reconnect, upgrade, or test teardown+setup).
 *
 * This patch MUST run as a post-patch (after db.migrate() has created the
 * table). It is safe to run even when the table already has rows.
 */
async function execute(dm: DatabaseManager): Promise<void> {
  const knex = dm.db!.knex!;
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_dghir_evidence_hash
      ON DuhGoodsImportRecord (evidenceHash)
  `);
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_dghir_identity_version
      ON DuhGoodsImportRecord (identityKey, evidenceVersion)
  `);
}

export default { execute };
