export const shorthands = undefined;

export const up = (pgm) => {
  pgm.sql(`
    DROP TRIGGER IF EXISTS prevent_inactive_supplier_association
    ON supplier_products;
  `);

  pgm.sql(`
    CREATE TRIGGER prevent_inactive_supplier_association
    BEFORE INSERT OR UPDATE OF supplier_id, product_id
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
    CREATE TRIGGER prevent_inactive_supplier_association
    BEFORE INSERT OR UPDATE OF supplier_id
    ON supplier_products
    FOR EACH ROW
    EXECUTE FUNCTION check_supplier_is_active();
  `);
};
