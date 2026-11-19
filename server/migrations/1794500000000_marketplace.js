export const up = (pgm) =>
  pgm.sql(`
  CREATE TABLE stores (
    id bigserial PRIMARY KEY, owner_id bigint NOT NULL UNIQUE REFERENCES users,
    name varchar(120) NOT NULL, slug varchar(68) NOT NULL UNIQUE,
    description text NOT NULL DEFAULT '', category varchar(100) NOT NULL,
    contact varchar(254) NOT NULL, pickup text NOT NULL,
    logo text NOT NULL DEFAULT '', cover text NOT NULL DEFAULT '',
    published boolean NOT NULL DEFAULT false, slug_locked boolean NOT NULL DEFAULT false
  );
  ALTER TABLE products ADD COLUMN store_id bigint REFERENCES stores,
    ADD COLUMN archived boolean NOT NULL DEFAULT false,
    ADD COLUMN photo text NOT NULL DEFAULT '';
  ALTER TABLE orders ADD COLUMN store_id bigint REFERENCES stores,
    ADD COLUMN pickup_snapshot text;
  CREATE INDEX market_products ON products(store_id, archived, id);
  CREATE INDEX market_orders ON orders(store_id, created_at DESC);
`);
export const down = (pgm) =>
  pgm.sql(`
  LOCK TABLE stores IN ACCESS EXCLUSIVE MODE;
  DO $$ BEGIN IF EXISTS (SELECT FROM stores) THEN
    RAISE EXCEPTION 'Rollback would remove store data'; END IF; END $$;
  ALTER TABLE orders DROP COLUMN store_id, DROP COLUMN pickup_snapshot;
  ALTER TABLE products DROP COLUMN store_id, DROP COLUMN archived, DROP COLUMN photo;
  DROP TABLE stores;
`);
