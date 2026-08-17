import { DatabaseManager } from '../database/manager';

/**
 * Version 0.38.8 — DB-level integrity constraints for settlement groups.
 *
 * 1. UNIQUE INDEX on DuhGoodsSettlementGroup(settlementRecord):
 *    One settlement group per settlement import record. Enforced atomically by
 *    SQLite so concurrent callers that both pass a SELECT-first check still
 *    produce only one group.
 *
 * 2. BEFORE INSERT trigger dghrm_prevent_accepted_insert_conflict:
 *    Settlement-group members are inserted directly with status='accepted'
 *    (not via the UPDATE path that the existing Phase-4A trigger guards).
 *    This trigger mirrors the invariant for the INSERT path:
 *
 *    - A leftRecord may not appear in more than one accepted match unless
 *      both the existing and new rows share the same non-NULL settlementGroup
 *      (idempotent re-run of the same group).
 *    - Raises ABORT with the same sentinel message as the UPDATE trigger so
 *      callers handle both paths uniformly.
 *
 *    The existing dghrm_prevent_accepted_record_conflict (BEFORE UPDATE)
 *    is NOT touched; it continues to guard Phase-4A reconciliation.
 */
async function execute(dm: DatabaseManager): Promise<void> {
  const knex = dm.db!.knex!;

  // 1. One settlement group per settlement record (atomic, concurrency-safe).
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_dghsg_settlement_record
    ON DuhGoodsSettlementGroup (settlementRecord)
  `);

  // 2. INSERT-path accepted-membership guard for settlement-group members.
  //
  //    Allows same (leftRecord, settlementGroup) pair — idempotent re-run.
  //    Blocks leftRecord in a DIFFERENT accepted match (or no settlementGroup).
  //
  //    SQLite NULL semantics used deliberately:
  //      NEW.settlementGroup IS NOT NULL → TRUE only when a group is set
  //      settlementGroup IS NOT NULL     → TRUE only when existing row has a group
  //      settlementGroup = NEW.settlementGroup → equality, NULL-safe via IS NOT NULL guards
  await knex.raw(`
    CREATE TRIGGER IF NOT EXISTS dghrm_prevent_accepted_insert_conflict
    BEFORE INSERT ON DuhGoodsReconciliationMatch
    WHEN NEW.status = 'accepted'
    BEGIN
      SELECT CASE WHEN EXISTS (
        SELECT 1 FROM DuhGoodsReconciliationMatch
        WHERE status = 'accepted'
          AND leftRecord = NEW.leftRecord
          AND NOT (
            NEW.settlementGroup IS NOT NULL
            AND settlementGroup IS NOT NULL
            AND settlementGroup = NEW.settlementGroup
          )
      ) THEN RAISE(ABORT, 'DuhGoods accepted reconciliation conflict') END;
    END
  `);
}

export default { execute };
