const redisManager = require("../config/redis");

const {
  getProducts,
  getProductById,
  validateProductId,
  validateProductPagination,
} = require("./product.service");

const CACHE_TTL_SECONDS = 60;
const CATALOG_VERSION_KEY = "products:catalog:version";

// Validate the structure of a cached product.
function isValidProduct(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.prototype.hasOwnProperty.call(value, "id")
  );
}

// Validate the structure of a cached product list.
function isValidProductList(value) {
  return Array.isArray(value) && value.every(isValidProduct);
}

function createProductCache({
  redis = redisManager,
  productService = {
    getProducts,
    getProductById,
    validateProductId,
    validateProductPagination,
  },
  logger = console,
} = {}) {
  async function getCatalogVersion(client) {
    // Initialize only when the key does not exist.
    await client.set(CATALOG_VERSION_KEY, "1", { NX: true });

    const version = await client.get(CATALOG_VERSION_KEY);

    if (!version || !/^\d+$/.test(version)) {
      throw new Error("Invalid product catalog version");
    }

    return version;
  }

  async function getCachedProducts(limit = 10, offset = 0) {
    productService.validateProductPagination(limit, offset);

    const client = redis.isRedisReady() ? redis.client : null;

    if (!client) {
      return productService.getProducts(limit, offset);
    }

    let cacheKey = null;

    // Redis operations only.
    try {
      const version = await getCatalogVersion(client);

      cacheKey =
        `products:list:v1:version:${version}:` +
        `limit:${limit}:offset:${offset}`;

      const cachedValue = await client.get(cacheKey);

      if (cachedValue !== null) {
        try {
          const parsedValue = JSON.parse(cachedValue);

          if (isValidProductList(parsedValue)) {
            return parsedValue;
          }

          logger.warn(
            "[ProductCache] Cached product list has an invalid structure",
          );
        } catch (error) {
          logger.warn(
            "[ProductCache] Invalid cached product list:",
            error.message,
          );
        }
      }
    } catch (error) {
      logger.warn("[ProductCache] Redis read failed:", error.message);
      cacheKey = null;
    }

    // PostgreSQL operation is outside the Redis catch.
    // A database error propagates without a second query.
    const products = await productService.getProducts(limit, offset);

    // Redis population is optional.
    if (cacheKey) {
      try {
        await client.set(cacheKey, JSON.stringify(products), {
          EX: CACHE_TTL_SECONDS,
        });
      } catch (error) {
        logger.warn(
          "[ProductCache] Failed to cache product list:",
          error.message,
        );
      }
    }

    return products;
  }

  async function getCachedProductById(id) {
    productService.validateProductId(id);

    const client = redis.isRedisReady() ? redis.client : null;

    if (!client) {
      return productService.getProductById(id);
    }

    let cacheKey = null;

    // Redis operations only.
    try {
      const version = await getCatalogVersion(client);

      cacheKey = `products:detail:v1:version:${version}:${id}`;

      const cachedValue = await client.get(cacheKey);

      if (cachedValue !== null) {
        try {
          const parsedValue = JSON.parse(cachedValue);

          if (isValidProduct(parsedValue)) {
            return parsedValue;
          }

          logger.warn("[ProductCache] Cached product has an invalid structure");
        } catch (error) {
          logger.warn("[ProductCache] Invalid cached product:", error.message);
        }
      }
    } catch (error) {
      logger.warn("[ProductCache] Redis read failed:", error.message);
      cacheKey = null;
    }

    // PostgreSQL operation is outside the Redis catch.
    const product = await productService.getProductById(id);

    // Do not cache missing or structurally invalid products.
    if (isValidProduct(product) && cacheKey) {
      try {
        await client.set(cacheKey, JSON.stringify(product), {
          EX: CACHE_TTL_SECONDS,
        });
      } catch (error) {
        logger.warn("[ProductCache] Failed to cache product:", error.message);
      }
    }

    return product;
  }

  async function invalidateProductCatalog() {
    const client = redis.isRedisReady() ? redis.client : null;

    if (!client) {
      return false;
    }

    try {
      // Preserve an existing version.
      await client.set(CATALOG_VERSION_KEY, "1", { NX: true });

      // New version makes all previous cache keys unreachable.
      await client.incr(CATALOG_VERSION_KEY);

      return true;
    } catch (error) {
      logger.error(
        "[ProductCache] Catalog invalidation failed:",
        error.message,
      );

      return false;
    }
  }

  return {
    getCachedProducts,
    getCachedProductById,
    invalidateProductCatalog,
  };
}

const productCache = createProductCache();

module.exports = {
  ...productCache,
  createProductCache,
  CACHE_TTL_SECONDS,
  CATALOG_VERSION_KEY,
  isValidProduct,
  isValidProductList,
};
