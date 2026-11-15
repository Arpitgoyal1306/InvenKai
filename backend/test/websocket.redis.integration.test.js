const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { once } = require("node:events");
const WebSocket = require("ws");

const redis = require("../src/config/redis");

const { createWebSocketService } = require("../src/services/websocket.service");

const {
  INVENTORY_CHANNEL,
} = require("../src/services/inventory-events.service");

const ORIGIN = process.env.CLIENT_URL || "http://localhost:5173";

test(
  "delivers inventory events through real Redis Pub/Sub",
  { skip: !process.env.REDIS_URL },
  async () => {
    let server;
    let service;
    let socket;

    try {
      const connected = await redis.connectRedis();

      assert.equal(connected, true);

      const publisher = redis.client;

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
      });

      server = http.createServer();
      service.attach(server);

      server.listen(0, "127.0.0.1");
      await once(server, "listening");

      const address = server.address();
      const url = `ws://127.0.0.1:${address.port}/ws`;

      // Start the dedicated Redis subscriber before publishing.
      assert.equal(await service.startSubscriber(), true);

      socket = new WebSocket(`${url}?ticket=integration-ticket`, {
        headers: {
          Origin: ORIGIN,
        },
      });

      await once(socket, "open");

      const eventPromise = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error("Timed out waiting for Redis event"));
        }, 5000);

        socket.once("message", (message) => {
          clearTimeout(timeout);

          try {
            resolve(JSON.parse(message.toString()));
          } catch (error) {
            reject(error);
          }
        });

        socket.once("error", (error) => {
          clearTimeout(timeout);
          reject(error);
        });
      });

      const expectedEvent = {
        type: "inventory.updated",
        data: {
          productId: 987654,
          quantity: 12,
        },
        timestamp: new Date().toISOString(),
      };

      await publisher.publish(INVENTORY_CHANNEL, JSON.stringify(expectedEvent));

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
        await new Promise((resolve) => {
          server.close(resolve);
        });
      }

      await redis.closeRedis();
    }
  },
);
