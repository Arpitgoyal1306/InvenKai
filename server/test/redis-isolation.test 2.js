const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createRedisManager } = require("../src/config/redis");

test("test Redis configuration rejects the same endpoint across logical databases", t => {
  const saved = { app: process.env.REDIS_URL, test: process.env.TEST_REDIS_URL };
  t.after(() => {
    for (const [key, value] of [["REDIS_URL", saved.app], ["TEST_REDIS_URL", saved.test]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  process.env.REDIS_URL = "redis://localhost/0";
  process.env.TEST_REDIS_URL = "redis://user:example@LOCALHOST:6379/15";
  assert.throws(() => createRedisManager(), /same Redis endpoint/);
});

test("test Redis startup rejects a shared live instance reached through a different endpoint", {
  skip: !process.env.TEST_REDIS_URL,
}, async t => {
  // Use a temporary TCP relay so this works even when the test service has no DNS alias.
  const net = require("node:net");
  const target = new URL(process.env.TEST_REDIS_URL);
  const relay = net.createServer(inbound => {
    const host = target.hostname.replace(/^\[|\]$/g, "");
    const port = Number(target.port || 6379);
    const outbound = target.protocol === "rediss:"
      ? require("node:tls").connect({ host, port, servername: net.isIP(host) ? undefined : host })
      : net.connect(port, host);
    inbound.pipe(outbound).pipe(inbound);
    inbound.on("close", () => outbound.destroy());
    outbound.on("close", () => inbound.destroy());
    outbound.on("error", () => inbound.destroy());
    inbound.on("error", () => outbound.destroy());
  });
  await new Promise((resolve, reject) => relay.once("error", reject).listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => relay.close(resolve)));
  const appUrl = process.env.REDIS_URL;
  t.after(() => { process.env.REDIS_URL = appUrl; });
  const alias = new URL(target);
  alias.protocol = "redis:";
  alias.hostname = "127.0.0.1";
  alias.port = String(relay.address().port);
  process.env.REDIS_URL = alias.href;
  const manager = createRedisManager();
  try {
    await assert.rejects(manager.connectRedis(), error => /same Redis instance/.test(error.cause?.message));
    assert.equal(manager.isRedisReady(), false);
    assert.equal(manager.client, null);
  } finally {
    await manager.closeRedis();
  }
});
