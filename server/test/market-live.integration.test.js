const assert = require("node:assert/strict");
const { once } = require("node:events");
const { test } = require("node:test");
const pool = require("../src/config/database");
const app = require("../src/app");
const live = require("../src/services/market-live.service");

test("marketplace SSE confirms readiness and delivers committed public inventory refreshes", async () => {
  await pool.verifyDatabaseIdentity();
  const server = app.listen(0, "127.0.0.1");
  const controller = new AbortController();
  const timeout = setTimeout(
    () =>
      controller.abort(
        new Error("Timed out waiting for a marketplace SSE refresh"),
      ),
    5000,
  );

  try {
    await once(server, "listening");
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/api/market/live`,
      { signal: controller.signal },
    );
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /^text\/event-stream/);
    const reader = response.body
      .pipeThrough(new TextDecoderStream())
      .getReader();
    let buffer = "";

    async function expectRefresh() {
      while (!buffer.includes("data: refresh\n\n")) {
        const { done, value } = await reader.read();
        assert.equal(
          done,
          false,
          "Marketplace SSE ended before the refresh arrived",
        );
        buffer += value;
      }
      buffer = buffer.slice(
        buffer.indexOf("data: refresh\n\n") + "data: refresh\n\n".length,
      );
    }

    await expectRefresh();
    await pool.query("SELECT pg_notify('market_inventory', $1)", [
      JSON.stringify({ owner: "1", public: true }),
    ]);
    await expectRefresh();
  } finally {
    clearTimeout(timeout);
    controller.abort();
    live.close();
    await Promise.all([
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
      pool.end(),
    ]);
  }
});
