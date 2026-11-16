const { test } = require("node:test");
const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const http = require("node:http");
const net = require("node:net");
const { once } = require("node:events");
const WebSocket = require("ws");

const execFileAsync = promisify(execFile);

const { createRedisManager } = require("../src/config/redis");
const { createWebSocketService } = require("../src/services/websocket.service");

const {
  INVENTORY_CHANNEL,
} = require("../src/services/inventory-events.service");

const HOST = "127.0.0.1";
const ORIGIN = "http://localhost:5173";

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getAvailablePort() {
  const server = net.createServer();

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, HOST, resolve);
  });

  const { port } = server.address();

  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });

  return port;
}

async function startRedisContainer(port) {
  const { stdout } = await execFileAsync("docker", [
    "run",
    "--rm",
    "-d",
    "-p",
    `${HOST}:${port}:6379`,
    "redis:7-alpine",
  ]);

  return stdout.trim();
}

async function waitForPort(port, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const available = await new Promise((resolve) => {
      const socket = net.createConnection({
        host: HOST,
        port,
      });

      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });

      socket.once("error", () => resolve(false));
    });

    if (available) {
      return;
    }

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
  { timeout: 30000 },
  async () => {
    let containerId;
    let manager;
    let service;
    let server;
    let socket;

    try {
      const port = await getAvailablePort();
      const redisUrl = `redis://${HOST}:${port}`;

      // Create the Redis manager while Redis is unavailable.
      manager = createRedisManager({
        url: redisUrl,
        logger: {
          info() {},
          warn() {},
          error() {},
        },
      });

      const connectionPromise = manager.connectRedis();

      // Confirm that the publisher has not connected yet.
      const connectedEarly = await Promise.race([
        connectionPromise.then(() => true),
        delay(150).then(() => false),
      ]);

      assert.equal(connectedEarly, false);
      assert.equal(manager.isRedisReady(), false);

      // Start an isolated Redis container.
      containerId = await startRedisContainer(port);

      assert.ok(containerId);

      await waitForPort(port);

      // The original publisher connection must recover.
      const connected = await connectionPromise;

      assert.equal(connected, true);
      assert.equal(manager.isRedisReady(), true);

      const publisher = manager.client;

      // Attach the WebSocket service to a real HTTP server.
      service = createWebSocketService({
        getRedisClient: () => publisher,

        consumeTicketFn: async (ticket) => {
          if (ticket !== "integration-ticket") {
            return null;
          }

          return {
            userId: "42",
            role: "inventory_manager",
          };
        },

        allowedOrigin: ORIGIN,
        retryBaseMs: 100,
        retryMaxMs: 800,
      });

      server = http.createServer();
      service.attach(server);

      server.listen(0, HOST);
      await once(server, "listening");

      // Start the dedicated Redis subscriber.
      assert.equal(await service.startSubscriber(), true);

      const address = server.address();
      const url = `ws://${HOST}:${address.port}/ws`;

      // Connect an authorized WebSocket client.
      socket = new WebSocket(`${url}?ticket=integration-ticket`, {
        headers: {
          Origin: ORIGIN,
        },
      });

      await once(socket, "open");

      const eventPromise = waitForWebSocketEvent(socket);

      const expectedEvent = {
        type: "inventory.updated",
        data: {
          productId: 987654,
          quantity: 12,
        },
        timestamp: new Date().toISOString(),
      };

      // Publish through the real Redis publisher.
      await publisher.publish(
        INVENTORY_CHANNEL,
        JSON.stringify(expectedEvent),
      );

      // Verify delivery through the real WebSocket connection.
      const receivedEvent = await eventPromise;

      assert.deepEqual(receivedEvent, expectedEvent);
    } finally {
      if (socket && socket.readyState !== WebSocket.CLOSED) {
        socket.terminate();
      }

      if (service) {
        await service.close();
      }

      if (server?.listening) {
        await new Promise((resolve) => server.close(resolve));
      }

      if (manager) {
        await manager.closeRedis();
      }

      // Remove only the temporary container created by this test.
      if (containerId) {
        await execFileAsync("docker", [
          "rm",
          "-f",
          containerId,
        ]).catch((error) => {
          console.error(
            "Could not remove temporary Redis container:",
            error.message,
          );
        });
      }
    }
  },
);
