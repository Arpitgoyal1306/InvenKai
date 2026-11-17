const { Pool } = require("pg");
require("dotenv").config();

function normalizeDatabaseIdentity(connectionString) {
  if (!connectionString || typeof connectionString !== "string") {
    return null;
  }

  let parsed;
  try {
    parsed = new URL(connectionString);
  } catch {
    throw new Error("Invalid PostgreSQL connection string format");
  }

  const databaseName = decodeURIComponent(
    parsed.pathname.replace(/^\/+/, ""),
  ).trim();

  if (!databaseName) {
    throw new Error("PostgreSQL connection string must include a database name");
  }

  const host = parsed.hostname.toLowerCase();
  const port = parsed.port || "5432";

  return {
    host,
    port,
    databaseName,
    key: `${host}:${port}/${databaseName}`,
  };
}

function resolveDatabaseConfig(env = process.env) {
  const isTestEnvironment = env.NODE_ENV === "test";

  const connectionString = isTestEnvironment
    ? env.TEST_DATABASE_URL
    : env.DATABASE_URL;

  if (!connectionString || !String(connectionString).trim()) {
    throw new Error(
      isTestEnvironment
        ? "TEST_DATABASE_URL is required in the test environment"
        : "DATABASE_URL is required",
    );
  }

  const targetIdentity = normalizeDatabaseIdentity(connectionString);

  if (isTestEnvironment && env.DATABASE_URL && String(env.DATABASE_URL).trim()) {
    const devIdentity = normalizeDatabaseIdentity(env.DATABASE_URL);
    if (devIdentity && targetIdentity.key === devIdentity.key) {
      throw new Error(
        "TEST_DATABASE_URL must point to a different database from DATABASE_URL",
      );
    }
  }

  return {
    isTestEnvironment,
    connectionString,
    expectedDatabaseName: targetIdentity.databaseName,
    targetIdentity,
  };
}

const { connectionString, expectedDatabaseName } = resolveDatabaseConfig();

const pool = new Pool({
  connectionString,
});

pool.expectedDatabaseName = expectedDatabaseName;
pool.resolveDatabaseConfig = resolveDatabaseConfig;
pool.normalizeDatabaseIdentity = normalizeDatabaseIdentity;

module.exports = pool;
