const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const net = require("node:net");

const { createRedisManager } = require("../src/config/redis");

const HOST = "127.0.0.1";
const PORT = 16379;
const REDIS_URL = `redis://${HOST}:${PORT}`;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPort({ timeoutMs = 5000 } = {}) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const available = await new Promise((resolve) => {
      const socket = net.createConnection({ host: HOST, port: PORT });

      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });

      socket.once("error", () => resolve(false));
    });

    if (available) return;

    await delay(50);
  }

  throw new Error(`Redis did not start on port ${PORT}`);
}

test("recovers the real Redis publisher after an initial outage", async () => {
  let redisProcess;
  let manager;
  let connectionPromise;

  try {
    manager = createRedisManager({
      url: REDIS_URL,
      logger: {
        info() {},
        warn() {},
        error() {},
      },
    });

    // Begin connecting while Redis is unavailable.
    connectionPromise = manager.connectRedis();

    await delay(150);

    assert.equal(manager.isRedisReady(), false);

    // Start an isolated Redis server.
    redisProcess = spawn(
      "redis-server",
      [
        "--bind",
        HOST,
        "--port",
        String(PORT),
        "--save",
        "",
        "--appendonly",
        "no",
      ],
      { stdio: "ignore" },
    );

    await waitForPort();

    // The original connection attempt should recover.
    const connected = await Promise.race([
      connectionPromise,
      delay(10000).then(() => {
        throw new Error("Redis publisher did not recover within 10 seconds");
      }),
    ]);

    assert.equal(connected, true);
    assert.equal(manager.isRedisReady(), true);
    assert.equal(manager.client.isReady, true);
  } finally {
    if (manager) {
      await manager.closeRedis();
    }

    if (redisProcess && redisProcess.exitCode === null) {
      redisProcess.kill("SIGTERM");

      await Promise.race([
        new Promise((resolve) => redisProcess.once("exit", resolve)),
        delay(3000),
      ]);
    }
  }
});
