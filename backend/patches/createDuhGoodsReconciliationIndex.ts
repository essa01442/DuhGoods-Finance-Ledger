import { DatabaseManager } from '../database/manager';

async function execute(dm: DatabaseManager): Promise<void> {
  const knex = dm.db!.knex!;
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_dghrm_edge_key
      ON DuhGoodsReconciliationMatch (edgeKey)
  `);
}

export default { execute };
