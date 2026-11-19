export const up = (pgm) =>
  pgm.sql("ALTER TABLE users ADD COLUMN avatar_url text");
export const down = (pgm) =>
  pgm.sql("ALTER TABLE users DROP COLUMN avatar_url");
