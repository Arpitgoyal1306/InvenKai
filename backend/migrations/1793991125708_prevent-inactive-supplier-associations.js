export const shorthands = undefined;

export const up = (pgm) => {
  pgm.sql(`
    CREATE OR REPLACE FUNCTION check_supplier_is_active()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
    DECLARE
      supplier_active BOOLEAN;
    BEGIN
      SELECT is_active
      INTO supplier_active
      FROM suppliers
      WHERE id = NEW.supplier_id
      FOR UPDATE;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'Supplier does not exist'
          USING ERRCODE = '23503';
      END IF;

      IF supplier_active = FALSE THEN
        RAISE EXCEPTION 'Cannot associate a product with an inactive supplier'
          USING ERRCODE = '23514';
      END IF;

      RETURN NEW;
    END;
    $$;
  `);

  pgm.sql(`
    CREATE TRIGGER prevent_inactive_supplier_association
    BEFORE INSERT OR UPDATE OF supplier_id
    ON supplier_products
    FOR EACH ROW
    EXECUTE FUNCTION check_supplier_is_active();
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    DROP TRIGGER IF EXISTS prevent_inactive_supplier_association
    ON supplier_products;
  `);

  pgm.sql(`
    DROP FUNCTION IF EXISTS check_supplier_is_active();
  `);
};