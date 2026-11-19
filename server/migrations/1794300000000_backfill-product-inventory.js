/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  pgm.sql(`
    INSERT INTO inventory (product_id, quantity)
    SELECT p.id, 0
    FROM products p
    WHERE NOT EXISTS (
      SELECT 1
      FROM inventory i
      WHERE i.product_id = p.id
    );
  `);
};

// This migration is intentionally irreversible.
// Removing backfilled inventory during rollback could destroy
// stock data created after the migration.
/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = () => {};
