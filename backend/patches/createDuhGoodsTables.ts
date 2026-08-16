import { DatabaseManager } from '../database/manager';

/**
 * Version 0.38.0 marker for DuhGoods ingestion schema introduction.
 *
 * DatabaseManager.#executeMigration() orchestrates:
 *   1. runPatches(pre, ...)   — pre-patches that run BEFORE schema sync
 *   2. db.migrate()           — creates/alters tables for all registered schemas
 *   3. runPatches(post, ...)  — post-patches that run AFTER schema sync ← HERE
 *
 * The DuhGoods tables (DuhGoodsImportSource, DuhGoodsImportRecord,
 * DuhGoodsReconciliationMatch) are registered in schemas/schemas.ts.
 * db.migrate() in step 2 creates them. This patch does NOT call migrate()
 * itself — doing so would be a recursive call inside the already-running
 * migration and is architecturally unsafe.
 *
 * Idempotency:
 * - First run: patch absent from PatchRun; stored DB version ≤ 0.38.0 → runs;
 *   recorded in PatchRun as succeeded.
 * - Subsequent runs: patch present in PatchRun (not failed) → skipped.
 * - Tables exist from step 2; db.migrate() in step 2 is itself idempotent
 *   (uses IF NOT EXISTS / column-existence checks in DatabaseCore).
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function execute(_dm: DatabaseManager): Promise<void> {
  // No data migration required at introduction. Tables are created by the
  // schema-sync step that precedes post-patches in the migration lifecycle.
}

export default { execute };
