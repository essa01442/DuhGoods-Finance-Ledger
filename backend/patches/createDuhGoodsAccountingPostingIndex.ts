import { DatabaseManager } from '../database/manager';

async function execute(dm: DatabaseManager): Promise<void> {
  await dm.db!.knex!.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_dghap_idempotency
    ON DuhGoodsAccountingPosting (idempotencyKey)
  `);
  await dm.db!.knex!.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_dghap_match
    ON DuhGoodsAccountingPosting (reconciliationMatch)
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
