import { DatabaseManager } from '../database/manager';

async function execute(dm: DatabaseManager): Promise<void> {
  await dm.db!.knex!.raw(`
    CREATE TRIGGER IF NOT EXISTS dghrm_prevent_accepted_record_conflict
    BEFORE UPDATE OF status ON DuhGoodsReconciliationMatch
    WHEN NEW.status = 'accepted'
    BEGIN
      SELECT CASE WHEN EXISTS (
        SELECT 1
        FROM DuhGoodsReconciliationMatch
        WHERE status = 'accepted'
          AND name <> NEW.name
          AND (
            leftRecord IN (NEW.leftRecord, NEW.rightRecord)
            OR rightRecord IN (NEW.leftRecord, NEW.rightRecord)
          )
      ) THEN RAISE(ABORT, 'DuhGoods accepted reconciliation conflict') END;
    END
  `);
}

export default { execute };
