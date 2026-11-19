export const shorthands = undefined;

export const up = (pgm) => {
  pgm.sql(`
    CREATE TABLE inventory_transactions (
      id BIGSERIAL PRIMARY KEY,

      product_id BIGINT NOT NULL
        REFERENCES products(id) ON DELETE RESTRICT,

      performed_by BIGINT
        REFERENCES users(id) ON DELETE SET NULL,

      transaction_type VARCHAR(10) NOT NULL
        CHECK (transaction_type IN ('increase', 'decrease')),

      quantity INTEGER NOT NULL
        CHECK (quantity > 0),

      quantity_before INTEGER NOT NULL
        CHECK (quantity_before >= 0),

      quantity_after INTEGER NOT NULL
        CHECK (quantity_after >= 0),

      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

      CONSTRAINT valid_transaction_quantity CHECK (
        (
          transaction_type = 'increase'
          AND quantity_after::BIGINT =
              quantity_before::BIGINT + quantity::BIGINT
        )
        OR
        (
          transaction_type = 'decrease'
          AND quantity_after::BIGINT =
              quantity_before::BIGINT - quantity::BIGINT
        )
      )
    );

    CREATE INDEX idx_inventory_transactions_product_created
    ON inventory_transactions (product_id, created_at DESC);
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS inventory_transactions;
  `);
};
