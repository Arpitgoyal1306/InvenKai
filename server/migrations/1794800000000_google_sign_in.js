export const up = (pgm) => pgm.sql(`
  ALTER TABLE users ADD COLUMN google_subject text UNIQUE,
    ALTER COLUMN password_hash DROP NOT NULL,
    ADD CONSTRAINT users_sign_in_method CHECK (password_hash IS NOT NULL OR google_subject IS NOT NULL);
`);

export const down = (pgm) => pgm.sql(`
  ALTER TABLE users ALTER COLUMN password_hash SET NOT NULL,
    DROP CONSTRAINT users_sign_in_method,
    DROP COLUMN google_subject;
`);
