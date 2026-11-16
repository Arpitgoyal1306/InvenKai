require("dotenv").config();

const redis = require("../config/redis");
const pool = require("../config/database");
const { createOrderOutboxDispatcher } = require("../services/order-outbox-dispatcher.service");

const POLL_INTERVAL_MS = 2000;

async function startDispatcher() {
  const dispatcher = createOrderOutboxDispatcher();
  let stopping = false;
  let timer = null;
  let running = false;

  async function poll() {
    if (stopping || running) return;
    running = true;
    try {
      const result = await dispatcher.dispatchBatch();
      if (result.claimed > 0) {
        console.info("[Outbox Dispatcher]", result);
      }
    } catch (error) {
      console.error("[Outbox Dispatcher] Poll failed:", error.message);
    } finally {
      running = false;
    }
  }

  await poll();
  timer = setInterval(() => void poll(), POLL_INTERVAL_MS);

  async function shutdown(signal) {
    if (stopping) return;
    stopping = true;
    console.info(`[Outbox Dispatcher] ${signal}; shutting down...`);
    if (timer) clearInterval(timer);
    while (running) await new Promise((resolve) => setTimeout(resolve, 50));
    await dispatcher.close();
    await redis.closeRedis();
    await pool.end();
  }

  process.once("SIGINT", () => void shutdown("SIGINT").catch(console.error));
  process.once("SIGTERM", () => void shutdown("SIGTERM").catch(console.error));
  return { shutdown };
}

if (require.main === module) {
  startDispatcher().catch(async (error) => {
    console.error("[Outbox Dispatcher] Startup failed:", error.message);
    await redis.closeRedis();
    await pool.end();
    process.exitCode = 1;
  });
}

module.exports = { startDispatcher };
