export const shorthands = undefined;

export const up = (pgm) => {
  // Orders table
  pgm.createTable("orders", {
    id: {
      type: "bigserial",
      primaryKey: true,
    },
    user_id: {
      type: "bigint",
      notNull: true,
      references: "users",
      onDelete: "RESTRICT",
    },
    status: {
      type: "varchar(20)",
      notNull: true,
      default: "placed",
    },
    total_amount: {
      type: "numeric(22,2)",
      notNull: true,
      default: 0,
    },
    created_at: {
      type: "timestamp",
      notNull: true,
      default: pgm.func("current_timestamp"),
    },
    updated_at: {
      type: "timestamp",
      notNull: true,
      default: pgm.func("current_timestamp"),
    },
  });

  pgm.addConstraint("orders", "orders_total_amount_nonnegative", {
    check: "total_amount >= 0",
  });

  pgm.addConstraint("orders", "orders_status_check", {
    check: "status IN ('placed', 'processing', 'completed', 'cancelled')",
  });

  pgm.createIndex("orders", ["user_id", "created_at"], {
    name: "idx_orders_user_created",
  });

  // Order items table
  pgm.createTable("order_items", {
    id: {
      type: "bigserial",
      primaryKey: true,
    },
    order_id: {
      type: "bigint",
      notNull: true,
      references: "orders",
      onDelete: "CASCADE",
    },
    product_id: {
      type: "bigint",
      notNull: true,
      references: "products",
      onDelete: "RESTRICT",
    },
    product_name: {
      type: "varchar(200)",
      notNull: true,
    },
    sku: {
      type: "varchar(100)",
    },
    unit_price: {
      type: "numeric(10,2)",
      notNull: true,
    },
    quantity: {
      type: "integer",
      notNull: true,
    },
  });

  // Database calculates each item's total.
  pgm.sql(`
    ALTER TABLE order_items
    ADD COLUMN line_total NUMERIC(20,2)
    GENERATED ALWAYS AS (unit_price * quantity) STORED;
  `);

  pgm.addConstraint("order_items", "order_items_quantity_positive", {
    check: "quantity > 0",
  });

  pgm.addConstraint("order_items", "order_items_price_nonnegative", {
    check: "unit_price >= 0",
  });

  pgm.addConstraint("order_items", "order_items_unique_product", {
    unique: ["order_id", "product_id"],
  });

  pgm.createIndex("order_items", ["product_id"], {
    name: "idx_order_items_product",
  });

  // Link inventory deductions to their originating order.
  pgm.addColumn("inventory_transactions", {
    order_id: {
      type: "bigint",
    },
  });

  pgm.addConstraint(
    "inventory_transactions",
    "fk_inventory_transactions_order",
    {
      foreignKeys: {
        columns: "order_id",
        references: "orders(id)",
        onDelete: "RESTRICT",
      },
    },
  );

  pgm.addConstraint("inventory_transactions", "inventory_order_decrease_only", {
    check: "order_id IS NULL OR transaction_type = 'decrease'",
  });

  pgm.createIndex("inventory_transactions", ["order_id"], {
    name: "idx_inventory_transactions_order",
  });
};

export const down = (pgm) => {
  // Remove order references before dropping orders.
  pgm.dropIndex("inventory_transactions", ["order_id"], {
    name: "idx_inventory_transactions_order",
  });

  pgm.dropConstraint("inventory_transactions", "inventory_order_decrease_only");

  pgm.dropConstraint(
    "inventory_transactions",
    "fk_inventory_transactions_order",
  );

  pgm.dropColumn("inventory_transactions", "order_id");

  pgm.dropTable("order_items");
  pgm.dropTable("orders");
};
