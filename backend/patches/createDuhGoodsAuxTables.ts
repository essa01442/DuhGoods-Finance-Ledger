import { DatabaseManager } from '../database/manager';

/**
 * Version 0.38.6 — DuhGoods VAT Policy and Import Profile auxiliary tables.
 *
 * Both DuhGoodsVATPolicy (Single) and DuhGoodsImportProfile are created by
 * db.migrate() in the schema-sync step. This patch is a marker and adds no
 * additional indexes since both tables are small and accessed by primary key.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function execute(_dm: DatabaseManager): Promise<void> {
  // No extra indexes needed for VAT policy (singleton) or import profiles.
}

export default { execute };
