import { DatabaseManager } from '../database/manager';

async function execute(dm: DatabaseManager): Promise<void> {
  await dm.db!.knex!.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_dghap_idempotency
    ON DuhGoodsAccountingPosting (idempotencyKey)
  `);
  // Partial unique index: at most one active (non-exception) posting per match.
  // Exception rows (status = 'exception') are excluded so that a validation-failure
  // record and a later successful posting can coexist for the same match, and so
  // that crash-recovery retries are not blocked by their prior failed reservation.
  await dm.db!.knex!.raw(`
    DROP INDEX IF EXISTS idx_dghap_match
  `);
  await dm.db!.knex!.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_dghap_active_match
    ON DuhGoodsAccountingPosting (reconciliationMatch)
    WHERE status != 'exception'
  `);
  await dm.db!.knex!.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_dghap_journal_reference
    ON JournalEntry (referenceNumber)
    WHERE referenceNumber LIKE 'DuhGoods:%'
  `);
  await dm.db!.knex!.raw(`
    CREATE TRIGGER IF NOT EXISTS dghap_claim_reversal_once
    BEFORE UPDATE OF status ON DuhGoodsAccountingPosting
    WHEN NEW.status = 'reversing' AND OLD.status <> 'posted'
    BEGIN
      SELECT RAISE(ABORT, 'DuhGoods accounting reversal already claimed');
    END
  `);
}

export default { execute };
