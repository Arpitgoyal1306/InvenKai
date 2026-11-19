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

  let devIdentity = null;
  if (isTestEnvironment && env.DATABASE_URL && String(env.DATABASE_URL).trim()) {
    devIdentity = normalizeDatabaseIdentity(env.DATABASE_URL);
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
    devIdentity,
  };
}

const {
  connectionString,
  expectedDatabaseName,
  targetIdentity,
  devIdentity,
} = resolveDatabaseConfig();

const pool = new Pool({
  connectionString,
});

pool.expectedDatabaseName = expectedDatabaseName;
pool.targetIdentity = targetIdentity;
pool.devIdentity = devIdentity;
pool.devDatabaseName = devIdentity?.databaseName || null;
pool.resolveDatabaseConfig = resolveDatabaseConfig;
pool.normalizeDatabaseIdentity = normalizeDatabaseIdentity;

// Verifies the live connected database via current_database().
// Guarantees:
// 1. The active PostgreSQL connection's current_database() matches the
//    database name parsed from the configured connection URL.
// 2. If TEST_DATABASE_URL and DATABASE_URL share the same normalized
//    host:port, the active connection cannot use the development database name.
// Limitations:
// - PostgreSQL's inet_server_addr() / inet_server_port() return internal
//   backend addresses behind proxies/poolers (e.g. 127.0.0.1/32 on Neon)
//   rather than the configured hostname, and two distinct DNS hostnames or
//   pooler endpoints could still alias the same underlying server.
async function verifyDatabaseIdentity(targetPool = pool) {
  const result = await targetPool.query(
    "SELECT current_database() AS database_name",
  );
  const actualDatabaseName = result.rows[0]?.database_name;

  if (
    !actualDatabaseName ||
    actualDatabaseName !== targetPool.expectedDatabaseName
  ) {
    throw new Error(
      `Database identity mismatch: expected "${targetPool.expectedDatabaseName}", connected to "${actualDatabaseName || "unknown"}"`,
    );
  }

  const sharesServerWithDev =
    targetPool.targetIdentity && targetPool.devIdentity
      ? targetPool.targetIdentity.host === targetPool.devIdentity.host &&
        targetPool.targetIdentity.port === targetPool.devIdentity.port
      : Boolean(targetPool.devDatabaseName);

  const devDatabaseName =
    targetPool.devIdentity?.databaseName || targetPool.devDatabaseName;

  if (
    sharesServerWithDev &&
    devDatabaseName &&
    actualDatabaseName === devDatabaseName
  ) {
    throw new Error(
      "Refusing to run tests against the development database",
    );
  }

  return actualDatabaseName;
}

pool.verifyDatabaseIdentity = verifyDatabaseIdentity;

module.exports = pool;
