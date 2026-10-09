/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  pgm.createTable("inventory", {
    id: {
      type: "bigserial",
      primaryKey: true,
    },
    product_id: {
      type: "bigint",
      notNull: true,
      unique: true,
      references: "products",
      onDelete: "RESTRICT",
    },
    quantity: {
      type: "integer",
      notNull: true,
      default: 0,
      check: "quantity >= 0",
    },
    created_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("CURRENT_TIMESTAMP"),
    },
    updated_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("CURRENT_TIMESTAMP"),
    },
  });
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
  pgm.dropTable("inventory");
};
