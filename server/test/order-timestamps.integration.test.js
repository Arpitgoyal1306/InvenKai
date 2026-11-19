const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

if (process.env.NODE_ENV !== "test") throw new Error("Requires NODE_ENV=test");
const pool = require("../src/config/database");
after(() => pool.end());

test("populated orders require a historical zone and round-trip both timestamp columns", async () => {
  await pool.verifyDatabaseIdentity();
  const { jiti, MigrationBuilder } = await import("node-pg-migrate");
  const migration = await jiti.import(path.resolve(__dirname, "../migrations/1794400000000_order-timestamps.js"));
  const client = await pool.connect();
  async function migrate(direction) {
    const builder = new MigrationBuilder({}, {}, false, console);
    migration[direction](builder);
    for (const sql of builder.getSqlSteps()) await client.query(sql);
  }

  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL search_path TO pg_temp");
    await client.query("SET LOCAL TIME ZONE 'UTC'");
    await client.query("SET LOCAL invenkai.order_timezone TO ''");
    await client.query(`
      CREATE TEMP TABLE orders (id int PRIMARY KEY, created_at timestamp, updated_at timestamp);
      INSERT INTO orders VALUES
        (1, '2026-01-12 22:45:00.123456', '2026-01-13 00:15:00'),
        (2, '2026-07-12 22:45:00.123456', '2026-07-13 00:15:00');
    `);
    const snapshot = () => client.query(`
      SELECT created_at::text, updated_at::text, pg_typeof(created_at)::text AS created_type,
             pg_typeof(updated_at)::text AS updated_type FROM orders ORDER BY id
    `).then(result => result.rows);
    const original = await snapshot();
    await client.query("SAVEPOINT before_conversion");
    await assert.rejects(migrate("up"), /verified historical order timezone/);
    await client.query("ROLLBACK TO before_conversion");
    assert.deepEqual(await snapshot(), original);

    await client.query("SET LOCAL invenkai.order_timezone TO 'America/New_York'");
    await migrate("up");
    const converted = await snapshot();
    assert.deepEqual(converted.map(row => [row.created_at, row.updated_at]), [
      ["2026-01-13 03:45:00.123456+00", "2026-01-13 05:15:00+00"],
      ["2026-07-13 02:45:00.123456+00", "2026-07-13 04:15:00+00"],
    ]);
    for (const row of converted) {
      assert.equal(row.created_type, "timestamp with time zone");
      assert.equal(row.updated_type, "timestamp with time zone");
    }
    await client.query("SAVEPOINT before_rollback");
    await client.query("SET LOCAL invenkai.order_timezone TO ''");
    await assert.rejects(migrate("down"), /verified historical order timezone/);
    await client.query("ROLLBACK TO before_rollback");
    assert.deepEqual(await snapshot(), converted);

    await migrate("down");
    await client.query("SET LOCAL TIME ZONE 'Asia/Kolkata'");
    assert.deepEqual(await snapshot(), original);
  } finally {
    try { await client.query("ROLLBACK"); } finally { client.release(); }
  }
});
