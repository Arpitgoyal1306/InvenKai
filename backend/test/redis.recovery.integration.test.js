const { test } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const net = require("node:net");

const { createRedisManager } = require("../src/config/redis");

const HOST = "127.0.0.1";

function getDockerSkipReason() {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore", timeout: 5000 });
    return false;
  } catch {
    return "Docker daemon is unavailable; run this recovery test on a Docker-enabled environment.";
  }
}

const dockerSkipReason = getDockerSkipReason();

async function getAvailablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, HOST, resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  return port;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPort(port, { timeoutMs = 10000 } = {}) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const available = await new Promise((resolve) => {
      const socket = net.createConnection({ host: HOST, port });
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
    });

    if (available) return;
    await delay(50);
  }

  throw new Error(`Redis did not start on port ${port}`);
}

test("recovers the real Redis publisher after an initial outage", {
  skip: dockerSkipReason,
}, async () => {
  let containerStarted = false;
  let manager;
  let connectionPromise;
  let containerName;

  try {
    const port = await getAvailablePort();
    const redisUrl = `redis://${HOST}:${port}`;
    containerName = `invenkai-redis-recovery-${process.pid}`;

    manager = createRedisManager({
      url: redisUrl,
      logger: { info() {}, warn() {}, error() {} },
    });

    connectionPromise = manager.connectRedis();
    await delay(150);
    assert.equal(manager.isRedisReady(), false);

    execFileSync("docker", [
      "run", "-d", "--rm", "--name", containerName,
      "-p", `${HOST}:${port}:6379`, "redis:7-alpine",
    ], { stdio: "ignore" });
    containerStarted = true;

    await waitForPort(port);

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
    if (manager) await manager.closeRedis();

    if (containerStarted) {
      try {
        execFileSync("docker", ["rm", "-f", containerName], { stdio: "ignore" });
      } catch (error) {
        console.error("[Test] Could not remove temporary Redis container:", error.message);
      }
    }
  }
});
