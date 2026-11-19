export const up = (pgm) =>
  pgm.sql(`
  ALTER TABLE orders ADD COLUMN buyer_details jsonb;
  CREATE FUNCTION notify_market_inventory() RETURNS trigger LANGUAGE plpgsql AS $$
  DECLARE owner_key text; public_change boolean; store_key bigint;
  BEGIN
    IF TG_TABLE_NAME = 'inventory' THEN
      SELECT s.owner_id::text, s.published AND NOT p.archived, s.id
        INTO owner_key,public_change,store_key FROM products p JOIN stores s ON s.id=p.store_id
        WHERE p.id=NEW.product_id;
    ELSIF TG_TABLE_NAME = 'products' THEN
      SELECT s.owner_id::text, s.published AND (NOT NEW.archived OR NOT OLD.archived), s.id
        INTO owner_key,public_change,store_key FROM stores s WHERE s.id=NEW.store_id;
    ELSE
      owner_key := NEW.owner_id::text; store_key := NEW.id;
      public_change := NEW.published OR OLD.published;
    END IF;
    IF store_key IS NOT NULL THEN
      PERFORM pg_notify('market_inventory', json_build_object('owner',owner_key,'public',public_change)::text);
    END IF;
    RETURN NEW;
  END $$;
  CREATE TRIGGER market_inventory_change AFTER INSERT OR UPDATE OF quantity ON inventory
    FOR EACH ROW EXECUTE FUNCTION notify_market_inventory();
  CREATE TRIGGER market_product_change AFTER UPDATE OF name,price,description,category_id,photo,archived,low_stock_threshold ON products
    FOR EACH ROW EXECUTE FUNCTION notify_market_inventory();
  CREATE TRIGGER market_store_change AFTER UPDATE ON stores FOR EACH ROW EXECUTE FUNCTION notify_market_inventory();
`);
export const down = (pgm) =>
  pgm.sql(`
  LOCK TABLE orders IN ACCESS EXCLUSIVE MODE;
  DO $$ BEGIN IF EXISTS (SELECT FROM orders WHERE buyer_details IS NOT NULL) THEN
    RAISE EXCEPTION 'Rollback would remove checkout contact information'; END IF; END $$;
  DROP TRIGGER market_inventory_change ON inventory;
  DROP TRIGGER market_product_change ON products;
  DROP TRIGGER market_store_change ON stores;
  DROP FUNCTION notify_market_inventory();
  ALTER TABLE orders DROP COLUMN buyer_details;
`);
