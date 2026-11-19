
const redis = require("../config/redis");

const INVENTORY_CHANNEL = "inventory:updates";

function createInventoryEventPublisher({
  getRedisClient = () => redis.client,
  logger = console,
  now = () => new Date(),
  timeoutMs = 1000,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
} = {}) {
  async function publishInventoryUpdated({ productId, quantity }) {
    let timeoutId;

    try {
      const client = getRedisClient();

      // Redis is optional. Never let notification failures
      // affect an already committed inventory update.
      if (!client || client.isReady !== true) {
        return false;
      }

      const event = {
        type: "inventory.updated",
        data: {
          productId,
          quantity,
        },
        timestamp: now().toISOString(),
      };

      const publishPromise = client.publish(
        INVENTORY_CHANNEL,
        JSON.stringify(event),
      );

      const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeoutFn(() => {
          reject(new Error("Redis publish timed out"));
        }, timeoutMs);
      });

      await Promise.race([publishPromise, timeoutPromise]);

      return true;
    } catch (error) {
      try {
        logger.error(
          "[Inventory Events] Failed to publish update:",
          error.message,
        );
      } catch {
        // Intentionally ignored.
      }

      return false;
    } finally {
      if (timeoutId !== undefined) {
        clearTimeoutFn(timeoutId);
      }
    }
  }

  return {
    publishInventoryUpdated,
  };
}

const inventoryEventPublisher = createInventoryEventPublisher();

module.exports = {
  INVENTORY_CHANNEL,
  createInventoryEventPublisher,
  publishInventoryUpdated: inventoryEventPublisher.publishInventoryUpdated,
};
