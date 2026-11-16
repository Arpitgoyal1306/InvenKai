const crypto = require("node:crypto");
const redis = require("../config/redis");

const TICKET_TTL_SECONDS = 30;
const TICKET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

const ALLOWED_ROLES = ["admin", "inventory_manager"];

// GET + DEL must happen atomically.
// Otherwise, two simultaneous connections could consume the same ticket.
const CONSUME_TICKET_SCRIPT = `
  local value = redis.call("GET", KEYS[1])
  if not value then
    return nil
  end

  redis.call("DEL", KEYS[1])
  return value
`;

function createWebSocketTicketService({
  getRedisClient = () => redis.client,
  randomBytes = crypto.randomBytes,
  createHash = crypto.createHash,
} = {}) {
  function getReadyRedisClient() {
    const client = getRedisClient();

    if (!client || client.isReady !== true) {
      const error = new Error("Ticket service is temporarily unavailable");
      error.statusCode = 503;
      throw error;
    }

    return client;
  }

  async function issueTicket({ userId, role }) {
    if (!userId || !ALLOWED_ROLES.includes(role)) {
      const error = new Error("User is not authorized");
      error.statusCode = 403;
      throw error;
    }

    const client = getReadyRedisClient();

    const ticket = randomBytes(32).toString("base64url");

    const ticketHash = createHash("sha256").update(ticket).digest("hex");

    const key = `ws:ticket:${ticketHash}`;

    const payload = JSON.stringify({
      userId: String(userId),
      role,
    });

    const result = await client.set(key, payload, {
      EX: TICKET_TTL_SECONDS,
      NX: true,
    });

    if (result !== "OK") {
      const error = new Error("Could not issue WebSocket ticket");
      error.statusCode = 503;
      throw error;
    }

    return {
      ticket,
      expiresIn: TICKET_TTL_SECONDS,
    };
  }

  async function consumeTicket(ticket) {
    if (typeof ticket !== "string" || !TICKET_PATTERN.test(ticket)) {
      return null;
    }

    const client = getReadyRedisClient();

    const ticketHash = createHash("sha256").update(ticket).digest("hex");

    const key = `ws:ticket:${ticketHash}`;

    const payload = await client.eval(CONSUME_TICKET_SCRIPT, {
      keys: [key],
      arguments: [],
    });

    if (typeof payload !== "string") {
      return null;
    }

    let parsed;

    try {
      parsed = JSON.parse(payload);
    } catch {
      return null;
    }

    if (
      !parsed ||
      typeof parsed.userId !== "string" ||
      !parsed.userId ||
      !ALLOWED_ROLES.includes(parsed.role)
    ) {
      return null;
    }

    return parsed;
  }

  return {
    issueTicket,
    consumeTicket,
  };
}

const websocketTicketService = createWebSocketTicketService();

module.exports = {
  createWebSocketTicketService,
  issueTicket: websocketTicketService.issueTicket,
  consumeTicket: websocketTicketService.consumeTicket,
  TICKET_TTL_SECONDS,
};
