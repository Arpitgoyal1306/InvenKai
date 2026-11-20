export const up = (pgm) =>
  pgm.sql(`
    ALTER TABLE products ADD COLUMN deleted_at timestamptz,
      ADD CONSTRAINT products_deleted_seller_archived
        CHECK (deleted_at IS NULL OR (store_id IS NOT NULL AND archived));
  `);

export const down = (pgm) =>
  pgm.sql(`
    LOCK TABLE products IN ACCESS EXCLUSIVE MODE;
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM products WHERE deleted_at IS NOT NULL) THEN
        RAISE EXCEPTION 'Rollback would expose deleted products to sellers';
      END IF;
    END $$;
    ALTER TABLE products DROP CONSTRAINT products_deleted_seller_archived,
      DROP COLUMN deleted_at;
  `);
