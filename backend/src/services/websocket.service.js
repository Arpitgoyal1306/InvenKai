const { WebSocketServer, WebSocket } = require("ws");
const redis = require("../config/redis");

const { INVENTORY_CHANNEL } = require("./inventory-events.service");
const { consumeTicket } = require("./websocket-ticket.service");

function createWebSocketService({
  getRedisClient = () => redis.client,
  consumeTicketFn = consumeTicket,
  allowedOrigin = process.env.CLIENT_URL,
  logger = console,
  retryBaseMs = 1000,
  retryMaxMs = 30000,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
} = {}) {
  let webSocketServer = null;
  let subscriber = null;
  let httpServer = null;

  let publisherClient = null;
  let subscriberConnectPromise = null;
  let retryTimer = null;
  let retryDelay = retryBaseMs;

  let isClosing = false;
  let closePromise = null;
  let shouldRunSubscriber = false;
  let isSubscribed = false;

  const clients = new Set();
  const pendingUpgradeSockets = new Set();

  function rejectUpgrade(socket, statusCode, message) {
    if (socket.destroyed) return;

    socket.write(
      `HTTP/1.1 ${statusCode} ${message}\r\n` +
        "Connection: close\r\n" +
        "Content-Type: text/plain\r\n" +
        "Content-Length: 0\r\n\r\n",
    );

    socket.destroy();
  }

  function isValidOrigin(origin) {
    if (!origin || !allowedOrigin) {
      return false;
    }

    try {
      return new URL(origin).origin === new URL(allowedOrigin).origin;
    } catch {
      return false;
    }
  }

  function isValidInventoryEvent(event) {
    return (
      event &&
      event.type === "inventory.updated" &&
      event.data &&
      Number.isSafeInteger(event.data.productId) &&
      event.data.productId > 0 &&
      Number.isSafeInteger(event.data.quantity) &&
      event.data.quantity >= 0 &&
      typeof event.timestamp === "string"
    );
  }

  function broadcastInventoryUpdate(message) {
    let event;

    try {
      event = JSON.parse(message);
    } catch {
      logger.warn("[WebSocket] Ignored invalid Redis message.");
      return;
    }

    if (!isValidInventoryEvent(event)) {
      logger.warn("[WebSocket] Ignored invalid inventory event.");
      return;
    }

    const payload = JSON.stringify(event);

    for (const client of clients) {
      if (client.readyState !== WebSocket.OPEN) {
        continue;
      }

      try {
        client.send(payload);
      } catch (error) {
        logger.error(
          "[WebSocket] Failed to send inventory event:",
          error.message,
        );
      }
    }
  }

  // Redis subscriber retry management

  function clearRetryTimer() {
    if (retryTimer !== null) {
      clearTimeoutFn(retryTimer);
      retryTimer = null;
    }
  }

  function scheduleRetry() {
    if (
      isClosing ||
      !shouldRunSubscriber ||
      retryTimer !== null ||
      subscriberConnectPromise !== null
    ) {
      return;
    }

    const delay = retryDelay;
    retryDelay = Math.min(retryDelay * 2, retryMaxMs);

    logger.warn(`[WebSocket] Retrying Redis subscriber in ${delay}ms.`);

    retryTimer = setTimeoutFn(() => {
      retryTimer = null;
      void ensureSubscriber();
    }, delay);

    retryTimer?.unref?.();
  }

  function handleSubscriberEnd(client) {
    if (subscriber !== client || isClosing) {
      return;
    }

    logger.warn("[WebSocket] Redis subscriber connection ended.");

    subscriber = null;
    isSubscribed = false;

    scheduleRetry();
  }

  // Publisher event listeners

  function attachPublisherListeners(client) {
    if (publisherClient === client) {
      return;
    }

    if (publisherClient) {
      publisherClient.removeListener("ready", handlePublisherReady);
      publisherClient.removeListener("end", handlePublisherEnd);
    }

    publisherClient = client;

    if (!publisherClient) {
      return;
    }

    publisherClient.on("ready", handlePublisherReady);
    publisherClient.on("end", handlePublisherEnd);
  }

  function handlePublisherReady() {
    if (isClosing || !shouldRunSubscriber) {
      return;
    }

    logger.info("[WebSocket] Redis publisher is ready. Checking subscriber.");
    void ensureSubscriber();
  }

  function handlePublisherEnd() {
    if (isClosing || !shouldRunSubscriber) {
      return;
    }

    logger.warn("[WebSocket] Redis publisher disconnected.");
    scheduleRetry();
  }

  // Redis subscriber initialization and recovery

  async function ensureSubscriber() {
    if (isClosing || !shouldRunSubscriber) {
      return false;
    }

    if (subscriberConnectPromise) {
      return subscriberConnectPromise;
    }

    clearRetryTimer();

    let currentPublisher;

    try {
      currentPublisher = getRedisClient();
      attachPublisherListeners(currentPublisher);
    } catch (error) {
      logger.error(
        "[WebSocket] Could not access Redis publisher:",
        error.message,
      );

      scheduleRetry();
      return false;
    }

    if (!currentPublisher || currentPublisher.isReady !== true) {
      logger.warn(
        "[WebSocket] Redis publisher unavailable. Waiting for recovery.",
      );

      scheduleRetry();
      return false;
    }

    if (subscriber?.isReady && isSubscribed) {
      return true;
    }

    if (subscriber?.isOpen) {
      return false;
    }

    if (subscriber) {
      try {
        subscriber.destroy();
      } catch (error) {
        logger.warn(
          "[WebSocket] Could not destroy stale subscriber:",
          error.message,
        );
      }

      subscriber = null;
      isSubscribed = false;
    }

    let nextSubscriber;

    try {
      nextSubscriber = currentPublisher.duplicate();
    } catch (error) {
      logger.error(
        "[WebSocket] Could not create Redis subscriber:",
        error.message,
      );

      scheduleRetry();
      return false;
    }

    subscriber = nextSubscriber;
    isSubscribed = false;

    nextSubscriber.on("error", (error) => {
      logger.error("[WebSocket Redis Subscriber]", error.message);
    });

    nextSubscriber.on("reconnecting", () => {
      logger.warn("[WebSocket] Redis subscriber reconnecting.");
    });

    nextSubscriber.on("ready", () => {
      if (isSubscribed) {
        logger.info(
          "[WebSocket] Redis subscriber reconnected. Subscription restored.",
        );
      } else {
        logger.info("[WebSocket] Redis subscriber connection ready.");
      }
    });

    nextSubscriber.on("end", () => {
      handleSubscriberEnd(nextSubscriber);
    });

    let connected = false;

    subscriberConnectPromise = (async () => {
      try {
        await nextSubscriber.connect();

        if (isClosing || subscriber !== nextSubscriber) {
          if (nextSubscriber.isOpen) {
            nextSubscriber.destroy();
          }

          return false;
        }

        await nextSubscriber.subscribe(
          INVENTORY_CHANNEL,
          broadcastInventoryUpdate,
        );

        if (isClosing || subscriber !== nextSubscriber) {
          if (nextSubscriber.isOpen) {
            nextSubscriber.destroy();
          }

          return false;
        }

        isSubscribed = true;
        connected = true;
        retryDelay = retryBaseMs;

        logger.info(`[WebSocket] Subscribed to ${INVENTORY_CHANNEL}.`);
        return true;
      } catch (error) {
        logger.error("[WebSocket] Redis subscription failed:", error.message);

        if (subscriber === nextSubscriber) {
          subscriber = null;
          isSubscribed = false;
        }

        if (nextSubscriber.isOpen) {
          nextSubscriber.destroy();
        }

        return false;
      } finally {
        subscriberConnectPromise = null;

        if (!connected && !isClosing && shouldRunSubscriber) {
          scheduleRetry();
        }
      }
    })();

    return subscriberConnectPromise;
  }

  async function startSubscriber() {
    if (isClosing) {
      return false;
    }

    shouldRunSubscriber = true;
    return ensureSubscriber();
  }

  // WebSocket authentication and upgrade

  async function handleUpgrade(request, socket, head) {
    if (isClosing) {
      return rejectUpgrade(socket, 503, "Service Unavailable");
    }

    if (socket.destroyed) {
      return;
    }

    // Track the TCP socket while authentication is pending.
    pendingUpgradeSockets.add(socket);

    socket.once("close", () => {
      pendingUpgradeSockets.delete(socket);
    });

    let requestUrl;

    try {
      requestUrl = new URL(request.url, "http://localhost");
    } catch {
      return rejectUpgrade(socket, 400, "Bad Request");
    }

    if (requestUrl.pathname !== "/ws") {
      return rejectUpgrade(socket, 404, "Not Found");
    }

    if (!isValidOrigin(request.headers.origin)) {
      return rejectUpgrade(socket, 403, "Forbidden");
    }

    const tickets = requestUrl.searchParams.getAll("ticket");

    if (tickets.length !== 1 || !tickets[0]) {
      return rejectUpgrade(socket, 401, "Unauthorized");
    }

    let user;

    try {
      user = await consumeTicketFn(tickets[0]);
    } catch (error) {
      const statusCode = error.statusCode === 503 ? 503 : 401;

      return rejectUpgrade(
        socket,
        statusCode,
        statusCode === 503 ? "Service Unavailable" : "Unauthorized",
      );
    }

    // The client may disconnect while ticket validation is pending.
    if (socket.destroyed || !socket.writable) {
      return;
    }

    if (!user || !["admin", "inventory_manager"].includes(user.role)) {
      return rejectUpgrade(socket, 401, "Unauthorized");
    }

    if (isClosing || !webSocketServer) {
      return rejectUpgrade(socket, 503, "Service Unavailable");
    }

    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      // This socket is now managed as an established WebSocket client.
      pendingUpgradeSockets.delete(socket);

      // Protect against a disconnect or shutdown during the upgrade.
      if (socket.destroyed || isClosing) {
        webSocket.terminate();
        return;
      }

      webSocket.user = user;
      webSocketServer.emit("connection", webSocket, request);
    });
  }

  // WebSocket server attachment

  function attach(server) {
    if (webSocketServer) {
      throw new Error("WebSocket server is already attached");
    }

    httpServer = server;

    webSocketServer = new WebSocketServer({
      noServer: true,
      maxPayload: 1024,
      perMessageDeflate: false,
    });

    httpServer.on("upgrade", handleUpgrade);

    webSocketServer.on("connection", (webSocket) => {
      clients.add(webSocket);

      webSocket.on("message", () => {
        webSocket.close(1008, "Client messages are not supported");
      });

      webSocket.on("close", () => {
        clients.delete(webSocket);
      });

      webSocket.on("error", (error) => {
        logger.error("[WebSocket] Client connection error:", error.message);
      });
    });

    return webSocketServer;
  }

  // Graceful shutdown

  function close() {
    if (closePromise) {
      return closePromise;
    }

    isClosing = true;
    shouldRunSubscriber = false;

    closePromise = (async () => {
      clearRetryTimer();

      if (publisherClient) {
        publisherClient.removeListener("ready", handlePublisherReady);
        publisherClient.removeListener("end", handlePublisherEnd);
        publisherClient = null;
      }

      if (httpServer) {
        httpServer.removeListener("upgrade", handleUpgrade);
        httpServer = null;
      }

      // Destroy TCP sockets waiting for ticket validation.
      for (const socket of pendingUpgradeSockets) {
        socket.destroy();
      }

      pendingUpgradeSockets.clear();

      // Terminate established WebSocket clients.
      for (const client of clients) {
        client.terminate();
      }

      clients.clear();

      if (webSocketServer) {
        await new Promise((resolve) => {
          webSocketServer.close(() => resolve());
        });

        webSocketServer = null;
      }

      const currentSubscriber = subscriber;
      const pendingConnection = subscriberConnectPromise;

      subscriber = null;
      isSubscribed = false;

      if (currentSubscriber) {
        try {
          if (pendingConnection) {
            currentSubscriber.destroy();
          } else if (currentSubscriber.isOpen && currentSubscriber.isReady) {
            await currentSubscriber.close();
          } else if (currentSubscriber.isOpen) {
            currentSubscriber.destroy();
          }
        } catch (error) {
          logger.error(
            "[WebSocket] Subscriber shutdown failed:",
            error.message,
          );

          if (currentSubscriber.isOpen) {
            currentSubscriber.destroy();
          }
        }
      }

      if (pendingConnection) {
        await pendingConnection.catch(() => false);
      }
    })();

    return closePromise;
  }

  return {
    attach,
    startSubscriber,
    close,
  };
}

module.exports = {
  createWebSocketService,
};
