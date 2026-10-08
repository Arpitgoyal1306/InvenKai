/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  pgm.createTable("products", {
    id: {
      type: "bigserial",
      primaryKey: true,
    },
    category_id: {
      type: "bigint",
      notNull: true,
      references: "categories",
      onDelete: "RESTRICT",
    },
    name: {
      type: "varchar(200)",
      notNull: true,
    },
    description: {
      type: "text",
    },
    sku: {
      type: "varchar(100)",
      notNull: true,
      unique: true,
    },
    price: {
      type: "numeric(10,2)",
      notNull: true,
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
  pgm.dropTable("products");
};
