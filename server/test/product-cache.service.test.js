const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  createProductCache,
  CACHE_TTL_SECONDS,
  CATALOG_VERSION_KEY,
} = require("../src/services/product-cache.service");

// --------------------------------------------------
// FAKE REDIS CLIENT
// --------------------------------------------------


function createFakeRedis({ now = () => Date.now() } = {}) {
  const store = new Map();
  const setCalls = [];
  const expirations = new Map();

  function removeExpiredKey(key) {
    const expiresAt = expirations.get(key);

    if (expiresAt !== undefined && now() >= expiresAt) {
      store.delete(key);
      expirations.delete(key);
    }
  }

  const client = {
    async set(key, value, options = {}) {
      removeExpiredKey(key);

      setCalls.push({ key, value, options });

      if (options.NX && store.has(key)) {
        return null;
      }

      store.set(key, String(value));

      if (options.EX !== undefined) {
        expirations.set(key, now() + options.EX * 1000);
      } else {
        expirations.delete(key);
      }

      return "OK";
    },

    async get(key) {
      removeExpiredKey(key);
      return store.has(key) ? store.get(key) : null;
    },

    async incr(key) {
      removeExpiredKey(key);

      const current = Number(store.get(key) || 0);
      const next = current + 1;

      store.set(key, String(next));

      return next;
    },
  };

  return {
    store,
    setCalls,
    expirations,
    isRedisReady: () => true,

    get client() {
      return client;
    },
  };
}


// --------------------------------------------------
// MOCK PRODUCT SERVICE
// --------------------------------------------------

function createProductServiceMock() {
  const calls = {
    getProducts: 0,
    getProductById: 0,
  };

  const products = [
    { id: 1, name: "Keyboard" },
    { id: 2, name: "Mouse" },
  ];

  return {
    calls,
    products,

    validateProductPagination(limit, offset) {
      if (
        !Number.isSafeInteger(limit) ||
        limit <= 0 ||
        limit > 100 ||
        !Number.isSafeInteger(offset) ||
        offset < 0
      ) {
        throw new Error("Invalid pagination values");
      }
    },

    validateProductId(id) {
      if (!Number.isSafeInteger(Number(id)) || Number(id) <= 0) {
        throw new Error("Invalid product ID");
      }
    },

    async getProducts() {
      calls.getProducts++;
      return products;
    },

    async getProductById(id) {
      calls.getProductById++;

      return products.find((product) => product.id === Number(id)) || null;
    },
  };
}

// --------------------------------------------------
// TEST 1: PRODUCT LIST CACHE MISS AND TTL
// --------------------------------------------------

test("product list cache stores PostgreSQL results with a 60-second TTL", async () => {
  const redis = createFakeRedis();
  const productService = createProductServiceMock();

  const cache = createProductCache({ redis, productService });

  const result = await cache.getCachedProducts(10, 0);

  assert.deepEqual(result, productService.products);
  assert.equal(productService.calls.getProducts, 1);

  const version = redis.store.get(CATALOG_VERSION_KEY);

  const key = `products:list:v1:version:${version}:limit:10:offset:0`;

  assert.equal(redis.store.get(key), JSON.stringify(productService.products));

  assert.equal(CACHE_TTL_SECONDS, 60);

  // Verify the actual Redis SET command receives EX: 60.
  const listSetCall = redis.setCalls.find((call) =>
    call.key.startsWith("products:list:"),
  );

  assert.ok(listSetCall);
  assert.equal(listSetCall.options.EX, 60);
});

// --------------------------------------------------
// TEST 2: PRODUCT LIST CACHE HIT
// --------------------------------------------------

test("product list cache returns cached data without another PostgreSQL query", async () => {
  const redis = createFakeRedis();
  const productService = createProductServiceMock();

  const cache = createProductCache({ redis, productService });

  const firstResult = await cache.getCachedProducts(10, 0);
  const secondResult = await cache.getCachedProducts(10, 0);

  assert.deepEqual(secondResult, firstResult);
  assert.equal(productService.calls.getProducts, 1);
});

// --------------------------------------------------
// TEST 3: PAGINATION CACHE KEY SEPARATION
// --------------------------------------------------

test("different pagination values use separate cache keys", async () => {
  const redis = createFakeRedis();
  const productService = createProductServiceMock();

  const cache = createProductCache({ redis, productService });

  await cache.getCachedProducts(10, 0);
  await cache.getCachedProducts(10, 10);

  assert.equal(productService.calls.getProducts, 2);

  const keys = [...redis.store.keys()].filter((key) =>
    key.startsWith("products:list:"),
  );

  assert.equal(keys.length, 2);
});

// --------------------------------------------------
// TEST 4: PRODUCT DETAIL CACHE HIT
// --------------------------------------------------

test("product detail cache avoids repeated PostgreSQL queries", async () => {
  const redis = createFakeRedis();
  const productService = createProductServiceMock();

  const cache = createProductCache({ redis, productService });

  const firstResult = await cache.getCachedProductById(1);
  const secondResult = await cache.getCachedProductById(1);

  assert.deepEqual(secondResult, firstResult);
  assert.equal(productService.calls.getProductById, 1);

  const detailSetCall = redis.setCalls.find((call) =>
    call.key.startsWith("products:detail:"),
  );

  assert.ok(detailSetCall);
  assert.equal(detailSetCall.options.EX, 60);
});

// --------------------------------------------------
// TEST 5: MISSING PRODUCTS ARE NOT CACHED
// --------------------------------------------------

test("missing products are not cached", async () => {
  const redis = createFakeRedis();
  const productService = createProductServiceMock();

  const cache = createProductCache({ redis, productService });

  const result = await cache.getCachedProductById(999);

  assert.equal(result, null);
  assert.equal(productService.calls.getProductById, 1);

  const detailKeys = [...redis.store.keys()].filter((key) =>
    key.startsWith("products:detail:"),
  );

  assert.equal(detailKeys.length, 0);
});

// --------------------------------------------------
// TEST 6: REDIS READ FAILURE
// --------------------------------------------------

test("Redis read failure falls back to PostgreSQL exactly once", async () => {
  const redis = createFakeRedis();
  const productService = createProductServiceMock();

  redis.client.get = async () => {
    throw new Error("Redis unavailable");
  };

  const cache = createProductCache({
    redis,
    productService,
    logger: { warn() {}, error() {} },
  });

  const result = await cache.getCachedProducts(10, 0);

  assert.deepEqual(result, productService.products);
  assert.equal(productService.calls.getProducts, 1);
});

// --------------------------------------------------
// TEST 7: REDIS WRITE FAILURE
// --------------------------------------------------

test("Redis write failure does not fail the product read", async () => {
  const redis = createFakeRedis();
  const productService = createProductServiceMock();

  const originalSet = redis.client.set;

  redis.client.set = async (key, value, options) => {
    if (key.startsWith("products:list:")) {
      throw new Error("Redis write failed");
    }

    return originalSet(key, value, options);
  };

  const cache = createProductCache({
    redis,
    productService,
    logger: { warn() {}, error() {} },
  });

  const result = await cache.getCachedProducts(10, 0);

  assert.deepEqual(result, productService.products);
  assert.equal(productService.calls.getProducts, 1);
});

// --------------------------------------------------
// TEST 8: POSTGRESQL ERROR HANDLING
// --------------------------------------------------

test("PostgreSQL errors propagate without executing the query twice", async () => {
  const redis = createFakeRedis();
  const productService = createProductServiceMock();

  productService.getProducts = async () => {
    productService.calls.getProducts++;

    throw new Error("PostgreSQL unavailable");
  };

  const cache = createProductCache({
    redis,
    productService,
    logger: { warn() {}, error() {} },
  });

  await assert.rejects(cache.getCachedProducts(10, 0), {
    message: "PostgreSQL unavailable",
  });

  assert.equal(productService.calls.getProducts, 1);
});

// --------------------------------------------------
// TEST 9: CATALOG VERSION INVALIDATION
// --------------------------------------------------

test("catalog invalidation increments the version and bypasses old cache keys", async () => {
  const redis = createFakeRedis();
  const productService = createProductServiceMock();

  const cache = createProductCache({ redis, productService });

  await cache.getCachedProducts(10, 0);

  assert.equal(redis.store.get(CATALOG_VERSION_KEY), "1");

  const invalidated = await cache.invalidateProductCatalog();

  assert.equal(invalidated, true);
  assert.equal(redis.store.get(CATALOG_VERSION_KEY), "2");

  await cache.getCachedProducts(10, 0);

  assert.equal(productService.calls.getProducts, 2);

  const versionTwoKey = "products:list:v1:version:2:limit:10:offset:0";

  assert.equal(
    redis.store.get(versionTwoKey),
    JSON.stringify(productService.products),
  );
});

// --------------------------------------------------
// TEST 10: INVALIDATION FAILURE
// --------------------------------------------------

test("invalidation failure returns false instead of throwing", async () => {
  const redis = createFakeRedis();

  redis.client.incr = async () => {
    throw new Error("Redis increment failed");
  };

  const cache = createProductCache({
    redis,
    logger: { warn() {}, error() {} },
  });

  const result = await cache.invalidateProductCatalog();

  assert.equal(result, false);
});

// --------------------------------------------------
// TEST 11: EXISTING CATALOG VERSION PRESERVATION
// --------------------------------------------------

test("existing catalog version is preserved during initialization", async () => {
  const redis = createFakeRedis();
  const productService = createProductServiceMock();

  // Simulate an existing catalog version.
  redis.store.set(CATALOG_VERSION_KEY, "7");

  const cache = createProductCache({ redis, productService });

  await cache.getCachedProducts(10, 0);

  // Initialization must not reset the existing version.
  assert.equal(redis.store.get(CATALOG_VERSION_KEY), "7");

  const expectedKey = "products:list:v1:version:7:limit:10:offset:0";

  assert.ok(redis.store.has(expectedKey));
  assert.equal(productService.calls.getProducts, 1);
});



// --------------------------------------------------
// TEST 12: PRODUCT LIST CACHE EXPIRATION
// --------------------------------------------------

test("expired product list cache triggers a new PostgreSQL query", async () => {
  let currentTime = 1000;

  const redis = createFakeRedis({
    now: () => currentTime,
  });

  const productService = createProductServiceMock();
  const cache = createProductCache({ redis, productService });

  const firstResult = await cache.getCachedProducts(10, 0);

  assert.deepEqual(firstResult, productService.products);
  assert.equal(productService.calls.getProducts, 1);

  // Advance time beyond the 60-second TTL.
  currentTime += 60_001;

  const secondResult = await cache.getCachedProducts(10, 0);

  assert.deepEqual(secondResult, productService.products);
  assert.equal(productService.calls.getProducts, 2);
});

// --------------------------------------------------
// TEST 13: PRODUCT DETAIL CACHE EXPIRATION
// --------------------------------------------------

test("expired product detail cache triggers a new PostgreSQL query", async () => {
  let currentTime = 1000;

  const redis = createFakeRedis({
    now: () => currentTime,
  });

  const productService = createProductServiceMock();
  const cache = createProductCache({ redis, productService });

  const firstResult = await cache.getCachedProductById(1);

  assert.deepEqual(firstResult, productService.products[0]);
  assert.equal(productService.calls.getProductById, 1);

  // Advance time beyond the 60-second TTL.
  currentTime += 60_001;

  const secondResult = await cache.getCachedProductById(1);

  assert.deepEqual(secondResult, productService.products[0]);
  assert.equal(productService.calls.getProductById, 2);
});

// --------------------------------------------------
// TEST 14: INVALID PRODUCT LIST CACHE STRUCTURE
// --------------------------------------------------

test("invalid product list cache structure falls back to PostgreSQL", async () => {
  const redis = createFakeRedis();
  const productService = createProductServiceMock();

  const cache = createProductCache({
    redis,
    productService,
    logger: { warn() {}, error() {} },
  });

  const version = "1";
  const key =
    `products:list:v1:version:${version}:limit:10:offset:0`;

  redis.store.set(key, JSON.stringify({ unexpected: "value" }));

  const result = await cache.getCachedProducts(10, 0);

  assert.deepEqual(result, productService.products);
  assert.equal(productService.calls.getProducts, 1);

  assert.equal(
    redis.store.get(key),
    JSON.stringify(productService.products)
  );
});

// --------------------------------------------------
// TEST 15: INVALID PRODUCT DETAIL CACHE STRUCTURE
// --------------------------------------------------

test("invalid product detail cache structure falls back to PostgreSQL", async () => {
  const redis = createFakeRedis();
  const productService = createProductServiceMock();

  const cache = createProductCache({
    redis,
    productService,
    logger: { warn() {}, error() {} },
  });

  const key = "products:detail:v1:version:1:1";

  redis.store.set(key, JSON.stringify(null));

  const result = await cache.getCachedProductById(1);

  assert.deepEqual(result, productService.products[0]);
  assert.equal(productService.calls.getProductById, 1);

  assert.equal(
    redis.store.get(key),
    JSON.stringify(productService.products[0])
  );
});
