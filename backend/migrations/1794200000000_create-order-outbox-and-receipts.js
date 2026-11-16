export const shorthands = undefined;

export const up = (pgm) => {
  pgm.createTable("order_outbox", {
    id: { type: "bigserial", primaryKey: true },
    event_type: { type: "varchar(80)", notNull: true },
    order_id: {
      type: "bigint",
      notNull: true,
      references: "orders",
      onDelete: "CASCADE",
    },
    payload: { type: "jsonb", notNull: true },
    status: {
      type: "varchar(20)",
      notNull: true,
      default: "pending",
    },
    attempts: { type: "integer", notNull: true, default: 0 },
    available_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("current_timestamp"),
    },
    locked_until: { type: "timestamptz" },
    last_error: { type: "text" },
    dispatched_at: { type: "timestamptz" },
    created_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("current_timestamp"),
    },
    updated_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("current_timestamp"),
    },
  });

  pgm.addConstraint("order_outbox", "order_outbox_status_check", {
    check: "status IN ('pending', 'processing', 'dispatched')",
  });
  pgm.addConstraint("order_outbox", "order_outbox_attempts_nonnegative", {
    check: "attempts >= 0",
  });
  pgm.addConstraint("order_outbox", "order_outbox_unique_event_per_order", {
    unique: ["event_type", "order_id"],
  });
  pgm.createIndex("order_outbox", ["status", "available_at", "id"], {
    name: "idx_order_outbox_pending",
    where: "status = 'pending'",
  });
  pgm.createIndex("order_outbox", ["locked_until"], {
    name: "idx_order_outbox_expired_leases",
    where: "status = 'processing'",
  });

  pgm.createTable("receipts", {
    id: { type: "bigserial", primaryKey: true },
    order_id: {
      type: "bigint",
      notNull: true,
      references: "orders",
      onDelete: "RESTRICT",
      unique: true,
    },
    receipt_number: { type: "varchar(40)", notNull: true, unique: true },
    user_id: {
      type: "bigint",
      notNull: true,
      references: "users",
      onDelete: "RESTRICT",
    },
    total_amount: { type: "numeric(22,2)", notNull: true },
    items: { type: "jsonb", notNull: true },
    issued_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("current_timestamp"),
    },
  });

  pgm.addConstraint("receipts", "receipts_total_nonnegative", {
    check: "total_amount >= 0",
  });
  pgm.addConstraint("receipts", "receipts_items_array_check", {
    check: "jsonb_typeof(items) = 'array'",
  });
};

export const down = (pgm) => {
  pgm.dropTable("receipts");
  pgm.dropTable("order_outbox");
};
