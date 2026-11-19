export const up = (pgm) =>
  pgm.sql(`
  ALTER TABLE users ADD COLUMN phone varchar(28),
    ADD COLUMN pickup_address jsonb;
`);

export const down = (pgm) =>
  pgm.sql(`
  LOCK TABLE users IN ACCESS EXCLUSIVE MODE;
  DO $$ BEGIN
    IF EXISTS (SELECT FROM users WHERE phone IS NOT NULL OR pickup_address IS NOT NULL) THEN
      RAISE EXCEPTION 'Rollback would remove saved account details';
    END IF;
  END $$;
  ALTER TABLE users DROP COLUMN phone, DROP COLUMN pickup_address;
`);
