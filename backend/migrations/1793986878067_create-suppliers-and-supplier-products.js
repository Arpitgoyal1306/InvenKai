/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  // Create suppliers table
  pgm.createTable("suppliers", {
    id: {
      type: "bigserial",
      primaryKey: true,
    },
    name: {
      type: "varchar(200)",
      notNull: true,
    },
    contact_name: {
      type: "varchar(100)",
    },
    email: {
      type: "varchar(255)",
    },
    phone: {
      type: "varchar(30)",
    },
    is_active: {
      type: "boolean",
      notNull: true,
      default: true,
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

  // Prevent empty or whitespace-only supplier names
  pgm.addConstraint("suppliers", "suppliers_name_not_empty", {
    check: "BTRIM(name) <> ''",
  });

  // Require at least one contact method (email or phone)
  pgm.addConstraint("suppliers", "suppliers_contact_required", {
    check:
      "(email IS NOT NULL AND BTRIM(email) <> '') OR (phone IS NOT NULL AND BTRIM(phone) <> '')",
  });
  // Create supplier-products junction table
  pgm.createTable("supplier_products", {
    supplier_id: {
      type: "bigint",
      notNull: true,
      references: "suppliers",
      onDelete: "RESTRICT",
    },
    product_id: {
      type: "bigint",
      notNull: true,
      references: "products",
      onDelete: "RESTRICT",
    },
  });

  // Prevent duplicate supplier-product associations
  pgm.addConstraint(
    "supplier_products",
    "supplier_products_pkey",
    {
      primaryKey: ["supplier_id", "product_id"],
    }
  );

  // Index for finding suppliers associated with a product
  pgm.createIndex("supplier_products", "product_id");
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
  pgm.dropTable("supplier_products");
  pgm.dropTable("suppliers");
};
