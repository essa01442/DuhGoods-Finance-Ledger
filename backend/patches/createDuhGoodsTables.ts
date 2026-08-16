import { ModelNameEnum } from '../../models/types';
import { DatabaseManager } from '../database/manager';

async function execute(dm: DatabaseManager) {
  // Tables are created automatically from schema registration via updateSchemas.
  // This patch is a version marker so the migration runs once and is recorded
  // in PatchRun. The actual DDL is handled by the schema sync mechanism.
  const schemaNames = [
    ModelNameEnum.DuhGoodsImportSource,
    ModelNameEnum.DuhGoodsImportRecord,
    ModelNameEnum.DuhGoodsReconciliationMatch,
  ];

  for (const schemaName of schemaNames) {
    const exists = await dm.db?.knex?.schema.hasTable(schemaName);
    if (!exists) {
      await dm.db?.migrate();
      break;
    }
  }
}

export default { execute };
