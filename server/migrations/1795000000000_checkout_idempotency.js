export const up = (pgm) =>
  pgm.sql(`
  ALTER TABLE orders ADD COLUMN checkout_key varchar(128),
    ADD COLUMN checkout_fingerprint text;
  CREATE UNIQUE INDEX orders_checkout_key ON orders(user_id, checkout_key)
    WHERE checkout_key IS NOT NULL;
`);

export const down = (pgm) =>
  pgm.sql(`
  LOCK TABLE orders IN ACCESS EXCLUSIVE MODE;
  DO $$ BEGIN IF EXISTS (SELECT FROM orders WHERE checkout_key IS NOT NULL) THEN
    RAISE EXCEPTION 'Rollback would remove checkout retry protection'; END IF; END $$;
  DROP INDEX orders_checkout_key;
  ALTER TABLE orders DROP COLUMN checkout_key, DROP COLUMN checkout_fingerprint;
`);
