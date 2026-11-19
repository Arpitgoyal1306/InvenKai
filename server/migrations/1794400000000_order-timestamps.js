// Migrations run in a transaction. Hold the lock across the empty-table check
// and conversion so a concurrent checkout cannot change that decision.
function convertOrderTimes(pgm, type) {
  pgm.sql(`
    LOCK TABLE orders IN ACCESS EXCLUSIVE MODE;
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM orders)
         AND NULLIF(current_setting('invenkai.order_timezone', true), '') IS NULL THEN
        RAISE EXCEPTION 'Set invenkai.order_timezone to the verified historical order timezone';
      END IF;
    END $$;
    ALTER TABLE orders
      ALTER COLUMN created_at TYPE ${type} USING created_at AT TIME ZONE
        COALESCE(NULLIF(current_setting('invenkai.order_timezone', true), ''), 'UTC'),
      ALTER COLUMN updated_at TYPE ${type} USING updated_at AT TIME ZONE
        COALESCE(NULLIF(current_setting('invenkai.order_timezone', true), ''), 'UTC');
  `);
}

export const up = pgm => convertOrderTimes(pgm, "timestamptz");
export const down = pgm => convertOrderTimes(pgm, "timestamp");
