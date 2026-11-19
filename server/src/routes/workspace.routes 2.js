const express = require("express");
const pool = require("../config/database");
const authenticate = require("../middleware/auth.middleware");
const authorize = require("../middleware/authorize-roles");
const {
  validateProductId,
  validateProductPagination,
} = require("../services/product.service");
const {
  invalidateProductCatalog,
} = require("../services/product-cache.service");
const { createOrderQueue } = require("../queues/order.queue");
const redis = require("../config/redis");
const {
  listFailedOrderReceipts,
  retryFailedOrderReceipt,
} = require("../scripts/retry-failed-order-receipts");

const router = express.Router();
const staff = [authenticate, authorize("admin", "inventory_manager")];
const admin = [authenticate, authorize("admin")];

router.post("/categories", ...staff, async (req, res) => {
  const name = req.body?.name;
  if (typeof name !== "string" || !name.trim() || name.trim().length > 100) {
    return res
      .status(400)
      .json({ message: "Enter a category name of 1 to 100 characters." });
  }
  const { rows } = await pool.query(
    "INSERT INTO categories(name) VALUES ($1) ON CONFLICT (name) DO NOTHING RETURNING id, name",
    [name.trim()],
  );
  if (!rows.length)
    return res.status(409).json({ message: "That category already exists." });
  return res.status(201).json({ category: rows[0] });
});

router.patch("/products/:id/threshold", ...staff, async (req, res) => {
  validateProductId(req.params.id);
  const threshold = req.body?.low_stock_threshold;
  if (
    threshold !== null &&
    (!Number.isInteger(threshold) || threshold < 0 || threshold > 2147483647)
  ) {
    return res
      .status(400)
      .json({ message: "Enter a nonnegative integer or clear the threshold." });
  }
  const { rows } = await pool.query(
    "UPDATE products SET low_stock_threshold=$2, updated_at=NOW() WHERE id=$1 RETURNING *",
    [req.params.id, threshold],
  );
  if (!rows.length)
    return res.status(404).json({ message: "Product not found." });
  await invalidateProductCatalog();
  return res.json({ product: rows[0] });
});

router.get("/suppliers/:id/products", ...staff, async (req, res) => {
  validateProductId(req.params.id);
  const limit = Number(req.query.limit ?? 20),
    offset = Number(req.query.offset ?? 0);
  validateProductPagination(limit, offset);
  const supplier = await pool.query(
    "SELECT id FROM suppliers WHERE id=$1 AND is_active",
    [req.params.id],
  );
  if (!supplier.rowCount)
    return res.status(404).json({ message: "Active supplier not found." });
  const { rows } = await pool.query(
    `SELECT p.id,p.name,p.sku,sp.supplier_id IS NOT NULL AS linked
     FROM products p LEFT JOIN supplier_products sp ON sp.product_id=p.id AND sp.supplier_id=$1
     WHERE ($2::boolean = false OR sp.supplier_id IS NOT NULL)
     ORDER BY p.name,p.id LIMIT $3 OFFSET $4`,
    [req.params.id, req.query.linked === "true", limit, offset],
  );
  return res.json({ products: rows });
});

router.put("/suppliers/:id/products/:productId", ...staff, async (req, res) => {
  validateProductId(req.params.id);
  validateProductId(req.params.productId);
  try {
    await pool.query(
      "INSERT INTO supplier_products(supplier_id, product_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
      [req.params.id, req.params.productId],
    );
  } catch (error) {
    if (error.code === "23503")
      return res
        .status(404)
        .json({ message: "Supplier or product no longer exists." });
    if (error.code === "23514")
      return res.status(409).json({ message: "Supplier is inactive." });
    throw error;
  }
  return res.sendStatus(204);
});

router.delete(
  "/suppliers/:id/products/:productId",
  ...staff,
  async (req, res) => {
    validateProductId(req.params.id);
    validateProductId(req.params.productId);
    await pool.query(
      "DELETE FROM supplier_products WHERE supplier_id=$1 AND product_id=$2",
      [req.params.id, req.params.productId],
    );
    return res.sendStatus(204);
  },
);

router.get("/orders/:id/receipt", authenticate, async (req, res) => {
  validateProductId(req.params.id);
  const { rows } = await pool.query(
    `SELECT r.receipt_number, r.issued_at, r.total_amount, r.items
     FROM orders o LEFT JOIN receipts r ON r.order_id=o.id
     WHERE o.id=$1 AND o.user_id=$2`,
    [req.params.id, req.user.id],
  );
  if (!rows.length)
    return res.status(404).json({ message: "Order not found." });
  return res.json({ receipt: rows[0].receipt_number ? rows[0] : null });
});

async function withReceiptQueue(action) {
  if (!redis.isRedisReady())
    throw Object.assign(new Error("Redis is unavailable"), { statusCode: 503 });
  const resources = await createOrderQueue();
  try {
    return await action(resources.queue);
  } finally {
    await resources.close();
  }
}

router.get("/operations/summary", ...admin, async (_req, res) => {
  const { rows } = await pool.query(`
    SELECT COUNT(*) FILTER (WHERE status='pending') AS pending,
           COUNT(*) FILTER (WHERE status='processing') AS processing,
           COUNT(*) FILTER (WHERE status='dispatched') AS dispatched,
           (SELECT COUNT(*) FROM receipts) AS issued
    FROM order_outbox
  `);
  return res.json({
    database: "connected",
    redis: redis.isRedisReady() ? "connected" : "unavailable",
    ...rows[0],
  });
});

router.get("/operations/failed-receipts", ...admin, async (_req, res) => {
  const jobs = await withReceiptQueue(listFailedOrderReceipts);
  return res.json({
    jobs: jobs.map(({ orderId, attemptsMade }) => ({ orderId, attemptsMade })),
  });
});

router.post(
  "/operations/failed-receipts/:id/retry",
  ...admin,
  async (req, res) => {
    validateProductId(req.params.id);
    const result = await withReceiptQueue((queue) =>
      retryFailedOrderReceipt(queue, pool, req.params.id),
    );
    return res.json({ alreadyGenerated: result.alreadyGenerated });
  },
);

module.exports = router;
