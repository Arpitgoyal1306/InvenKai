const { Pool } = require("pg");
require("dotenv").config();

const isTestEnvironment = process.env.NODE_ENV === "test";

const databaseUrl = isTestEnvironment
  ? process.env.TEST_DATABASE_URL
  : process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error(
    isTestEnvironment
      ? "TEST_DATABASE_URL is required in the test environment"
      : "DATABASE_URL is required",
  );
}

const pool = new Pool({
  connectionString: databaseUrl,
});

module.exports = pool;
