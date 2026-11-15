const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const net = require("node:net");
const { once } = require("node:events");
const WebSocket = require("ws");

const { createWebSocketService } = require("../src/services/websocket.service");

const ORIGIN = "http://localhost:5173";

function createMockRedis() {
  const subscriberHandlers = new Map();
  const publisherHandlers = new Map();
  let subscribedChannel = null;

  const subscriber = {
    isOpen: false,
    isReady: false,

    on(event, callback) {
      if (!subscriberHandlers.has(event)) subscriberHandlers.set(event, []);
      subscriberHandlers.get(event).push(callback);
      return this;
    },

    async connect() {
      this.isOpen = true;
      this.isReady = true;
    },

    async subscribe(channel, callback) {
      subscribedChannel = channel;
      this.messageHandler = callback;
    },

    async close() {
      this.isOpen = false;
      this.isReady = false;
    },

    destroy() {
      this.isOpen = false;
      this.isReady = false;
    },

    emit(event, value) {
      for (const callback of subscriberHandlers.get(event) || []) {
        callback(value);
      }
    },

    publishMessage(message) {
      this.messageHandler?.(message, subscribedChannel);
    },
  };

  const publisher = {
    isReady: true,

    on(event, callback) {
      if (!publisherHandlers.has(event)) publisherHandlers.set(event, []);
      publisherHandlers.get(event).push(callback);
      return this;
    },

    removeListener(event, callback) {
      const listeners = publisherHandlers.get(event) || [];
      publisherHandlers.set(
        event,
        listeners.filter((listener) => listener !== callback),
      );
      return this;
    },

    emit(event, value) {
      for (const callback of publisherHandlers.get(event) || []) {
        callback(value);
      }
      return this;
    },

    duplicate() {
      return subscriber;
    },
  };

  return {
    publisher,
    subscriber,
    get subscribedChannel() {
      return subscribedChannel;
    },
  };
}

async function createTestServer(options = {}) {
  const redisMock = createMockRedis();

  const service = createWebSocketService({
    getRedisClient: () => redisMock.publisher,

    consumeTicketFn:
      options.consumeTicketFn ||
      (async (ticket) => {
        if (ticket === "valid-ticket") {
          return {
            userId: "42",
            role: "inventory_manager",
          };
        }
        return null;
      }),

    allowedOrigin: ORIGIN,

    logger: {
      info() {},
      warn() {},
      error() {},
    },
  });

  const server = http.createServer();
  const webSocketServer = service.attach(server);

  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const address = server.address();
  const url = `ws://127.0.0.1:${address.port}/ws`;

  return {
    server,
    service,
    webSocketServer,
    redisMock,
    url,

    async close() {
      await service.close();

      if (server.listening) {
        await new Promise((resolve) => server.close(resolve));
      }
    },
  };
}

function connect(url, ticket, origin = ORIGIN) {
  return new WebSocket(`${url}?ticket=${encodeURIComponent(ticket)}`, {
    headers: { Origin: origin },
  });
}

function waitForUpgradeRejection(socket) {
  return new Promise((resolve, reject) => {
    socket.once("unexpected-response", (_request, response) => {
      resolve(response);
    });
    socket.once("error", reject);
  });
}

function waitForMessage(socket) {
  return new Promise((resolve, reject) => {
    socket.once("message", (message) => {
      try {
        resolve(JSON.parse(message.toString()));
      } catch (error) {
        reject(error);
      }
    });
    socket.once("error", reject);
  });
}

test("accepts an authorized connection with a valid ticket", async () => {
  const context = await createTestServer();

  try {
    const socket = connect(context.url, "valid-ticket");
    await once(socket, "open");

    assert.equal(socket.readyState, WebSocket.OPEN);
    socket.close();
  } finally {
    await context.close();
  }
});

test("rejects an invalid ticket", async () => {
  const context = await createTestServer();

  try {
    const socket = connect(context.url, "invalid-ticket");
    const response = await waitForUpgradeRejection(socket);

    assert.equal(response.statusCode, 401);
    socket.terminate();
  } finally {
    await context.close();
  }
});

test("rejects a connection from an unauthorized origin", async () => {
  const context = await createTestServer();

  try {
    const socket = connect(
      context.url,
      "valid-ticket",
      "https://attacker.example",
    );
    const response = await waitForUpgradeRejection(socket);

    assert.equal(response.statusCode, 403);
    socket.terminate();
  } finally {
    await context.close();
  }
});

test("rejects a connection without an origin", async () => {
  const context = await createTestServer();

  try {
    const socket = new WebSocket(`${context.url}?ticket=valid-ticket`);
    const response = await waitForUpgradeRejection(socket);

    assert.equal(response.statusCode, 403);
    socket.terminate();
  } finally {
    await context.close();
  }
});

test("rejects a user with an unauthorized role", async () => {
  const context = await createTestServer({
    consumeTicketFn: async () => ({
      userId: "42",
      role: "customer",
    }),
  });

  try {
    const socket = connect(context.url, "valid-ticket");
    const response = await waitForUpgradeRejection(socket);

    assert.equal(response.statusCode, 401);
    socket.terminate();
  } finally {
    await context.close();
  }
});

test("subscribes to the inventory Redis channel", async () => {
  const context = await createTestServer();

  try {
    const result = await context.service.startSubscriber();

    assert.equal(result, true);
    assert.equal(context.redisMock.subscribedChannel, "inventory:updates");
  } finally {
    await context.close();
  }
});

test("broadcasts a valid inventory event to connected clients", async () => {
  const context = await createTestServer();

  try {
    await context.service.startSubscriber();

    const socket = connect(context.url, "valid-ticket");
    await once(socket, "open");

    const messagePromise = waitForMessage(socket);

    const event = {
      type: "inventory.updated",
      data: {
        productId: 42,
        quantity: 9,
      },
      timestamp: "2026-11-12T10:30:00.000Z",
    };

    context.redisMock.subscriber.publishMessage(JSON.stringify(event));

    assert.deepEqual(await messagePromise, event);
    socket.close();
  } finally {
    await context.close();
  }
});

test("ignores malformed Redis messages", async () => {
  const context = await createTestServer();

  try {
    await context.service.startSubscriber();

    const socket = connect(context.url, "valid-ticket");
    await once(socket, "open");

    let received = false;
    socket.on("message", () => {
      received = true;
    });

    context.redisMock.subscriber.publishMessage("{invalid-json");
    context.redisMock.subscriber.publishMessage(
      JSON.stringify({ type: "unknown.event" }),
    );

    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(received, false);

    socket.close();
  } finally {
    await context.close();
  }
});

test("closes clients that send unsupported messages", async () => {
  const context = await createTestServer();

  try {
    const socket = connect(context.url, "valid-ticket");
    await once(socket, "open");

    const closePromise = once(socket, "close");
    socket.send("SUBSCRIBE");

    const [code] = await closePromise;
    assert.equal(code, 1008);
  } finally {
    await context.close();
  }
});

test("rejects connections when Redis ticket consumption is unavailable", async () => {
  const context = await createTestServer({
    consumeTicketFn: async () => {
      const error = new Error("Redis unavailable");
      error.statusCode = 503;
      throw error;
    },
  });

  try {
    const socket = connect(context.url, "valid-ticket");
    const response = await waitForUpgradeRejection(socket);

    assert.equal(response.statusCode, 503);
    socket.terminate();
  } finally {
    await context.close();
  }
});



test("does not upgrade a socket that disconnects during ticket validation", async () => {
  let resolveTicket;
  let notifyValidationStarted;

  const validationStarted = new Promise((resolve) => {
    notifyValidationStarted = resolve;
  });

  const ticketPromise = new Promise((resolve) => {
    resolveTicket = resolve;
  });

  const context = await createTestServer({
    consumeTicketFn: () => {
      notifyValidationStarted();
      return ticketPromise;
    },
  });

  let connectionCount = 0;

  context.webSocketServer.on("connection", () => {
    connectionCount += 1;
  });

  let clientSocket;

  try {
    const address = context.server.address();

    const serverSocketPromise = once(context.server, "connection");

    clientSocket = net.connect({
      host: "127.0.0.1",
      port: address.port,
    });

    await once(clientSocket, "connect");

    const [serverSocket] = await serverSocketPromise;

    clientSocket.write(
      [
        "GET /ws?ticket=valid-ticket HTTP/1.1",
        `Host: 127.0.0.1:${address.port}`,
        "Origin: http://localhost:5173",
        "Connection: Upgrade",
        "Upgrade: websocket",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
        "Sec-WebSocket-Version: 13",
        "",
        "",
      ].join("\r\n"),
    );

    // Wait until the server starts validating the ticket.
    await validationStarted;

    // Simulate the connection being closed before authentication finishes.
    serverSocket.destroy();

    assert.equal(serverSocket.destroyed, true);

    // Authentication completes after the socket has closed.
    resolveTicket({
      userId: "42",
      role: "inventory_manager",
    });

    await new Promise((resolve) => setImmediate(resolve));

    // The server must not establish a WebSocket connection.
    assert.equal(connectionCount, 0);
  } finally {
    resolveTicket(null);
    clientSocket?.destroy();
    await context.close();
  }
});

test("destroys pending upgrade sockets during shutdown", async () => {
  let resolveTicket;
  let notifyValidationStarted;

  const validationStarted = new Promise((resolve) => {
    notifyValidationStarted = resolve;
  });

  const ticketPromise = new Promise((resolve) => {
    resolveTicket = resolve;
  });

  const context = await createTestServer({
    consumeTicketFn: () => {
      notifyValidationStarted();
      return ticketPromise;
    },
  });

  let connectionCount = 0;
  let clientSocket;

  context.webSocketServer.on("connection", () => {
    connectionCount += 1;
  });

  try {
    const address = context.server.address();
    const serverSocketPromise = once(context.server, "connection");

    clientSocket = net.connect({
      host: "127.0.0.1",
      port: address.port,
    });

    await once(clientSocket, "connect");

    const [serverSocket] = await serverSocketPromise;

    clientSocket.write(
      [
        "GET /ws?ticket=valid-ticket HTTP/1.1",
        `Host: 127.0.0.1:${address.port}`,
        "Origin: http://localhost:5173",
        "Connection: Upgrade",
        "Upgrade: websocket",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
        "Sec-WebSocket-Version: 13",
        "",
        "",
      ].join("\r\n"),
    );

    // Wait until ticket validation is pending.
    await validationStarted;

    // Shutdown must destroy the pending TCP socket.
    await context.service.close();

    assert.equal(serverSocket.destroyed, true);

    // Finish authentication after shutdown.
    resolveTicket({
      userId: "42",
      role: "inventory_manager",
    });

    await new Promise((resolve) => setImmediate(resolve));

    // No WebSocket connection should be established.
    assert.equal(connectionCount, 0);
  } finally {
    resolveTicket(null);
    clientSocket?.destroy();
    await context.close();
  }
});