const { test } = require("node:test");
const assert = require("node:assert/strict");
const { execFile, execFileSync } = require("node:child_process");
const { promisify } = require("node:util");
const http = require("node:http");
const net = require("node:net");
const { once } = require("node:events");
const WebSocket = require("ws");

const execFileAsync = promisify(execFile);
const { createRedisManager } = require("../src/config/redis");
const { createWebSocketService } = require("../src/services/websocket.service");
const { INVENTORY_CHANNEL } = require("../src/services/inventory-events.service");

const HOST = "127.0.0.1";
const ORIGIN = "http://localhost:5173";

function getDockerSkipReason() {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore", timeout: 5000 });
    return false;
  } catch {
    return "Docker daemon is unavailable; run this recovery test on a Docker-enabled environment.";
  }
}

const dockerSkipReason = getDockerSkipReason();

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout(promise, timeoutMs, message) {
  let timeoutId;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeoutId);
  }
}

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

async function startRedisContainer(port) {
  const { stdout } = await execFileAsync("docker", [
    "run", "--rm", "-d", "-p", `${HOST}:${port}:6379`, "redis:7-alpine",
  ], { timeout: 15000 });
  return stdout.trim();
}

async function waitForPort(port, timeoutMs = 10000) {
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
    await delay(100);
  }
  throw new Error(`Redis container did not become ready on port ${port}`);
}

async function waitForWebSocketEvent(socket, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for inventory event"));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timeout);
      socket.removeListener("message", handleMessage);
      socket.removeListener("error", handleError);
    }

    function handleMessage(message) {
      cleanup();
      try {
        resolve(JSON.parse(message.toString()));
      } catch (error) {
        reject(error);
      }
    }

    function handleError(error) {
      cleanup();
      reject(error);
    }

    socket.once("message", handleMessage);
    socket.once("error", handleError);
  });
}

test(
  "delivers inventory events after recovering from an initial Redis outage",
  { timeout: 30000, skip: dockerSkipReason },
  async () => {
    let containerId;
    let manager;
    let service;
    let server;
    let socket;

    try {
      const port = await getAvailablePort();
      manager = createRedisManager({
        url: `redis://${HOST}:${port}`,
        logger: { info() {}, warn() {}, error() {} },
      });

      const connectionPromise = manager.connectRedis();
      const connectedEarly = await Promise.race([
        connectionPromise.then(() => true),
        delay(150).then(() => false),
      ]);

      assert.equal(connectedEarly, false);
      assert.equal(manager.isRedisReady(), false);

      containerId = await startRedisContainer(port);
      assert.ok(containerId);
      await waitForPort(port);

      const connected = await withTimeout(
        connectionPromise,
        10000,
        "Redis publisher did not recover within 10 seconds",
      );
      assert.equal(connected, true);
      assert.equal(manager.isRedisReady(), true);

      const publisher = manager.client;
      service = createWebSocketService({
        getRedisClient: () => publisher,
        consumeTicketFn: async (ticket) => ticket === "integration-ticket"
          ? { userId: "42", role: "inventory_manager" }
          : null,
        allowedOrigin: ORIGIN,
        retryBaseMs: 100,
        retryMaxMs: 800,
      });

      server = http.createServer();
      service.attach(server);
      server.listen(0, HOST);
      await once(server, "listening");

      assert.equal(await service.startSubscriber(), true);

      const address = server.address();
      socket = new WebSocket(`ws://${HOST}:${address.port}/ws?ticket=integration-ticket`, {
        headers: { Origin: ORIGIN },
      });
      await once(socket, "open");

      const eventPromise = waitForWebSocketEvent(socket);
      const expectedEvent = {
        type: "inventory.updated",
        data: { productId: 987654, quantity: 12 },
        timestamp: new Date().toISOString(),
      };

      await publisher.publish(INVENTORY_CHANNEL, JSON.stringify(expectedEvent));
      const receivedEvent = await eventPromise;
      assert.deepEqual(receivedEvent, expectedEvent);
    } finally {
      if (socket && socket.readyState !== WebSocket.CLOSED) socket.terminate();
      if (service) await service.close();
      if (server?.listening) await new Promise((resolve) => server.close(resolve));
      if (manager) await manager.closeRedis();

      if (containerId) {
        await execFileAsync("docker", ["rm", "-f", containerId], {
          timeout: 5000,
        }).catch((error) => {
          console.error("Could not remove temporary Redis container:", error.message);
        });
      }
    }
  },
);
