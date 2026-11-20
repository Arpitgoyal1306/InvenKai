const pool = require("../config/database");
const { publishInventoryUpdated } = require("./inventory-events.service");

const MAX_STOCK = 2147483647;

function createError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function createInventoryService({
  db = pool,
  publishInventoryUpdatedFn = publishInventoryUpdated,
} = {}) {
  async function getInventoryByProductId(productId) {
    const result = await db.query(
      `SELECT product_id, quantity, created_at, updated_at
       FROM inventory
       WHERE product_id = $1 AND EXISTS (SELECT 1 FROM products WHERE id=$1 AND store_id IS NULL AND NOT archived)`,
      [productId],
    );

    return result.rows[0] ?? null;
  }

  async function getLowStockProducts(database = db) {
    const result = await database.query(
      `SELECT
         p.id AS product_id,
         p.name,
         p.sku,
         p.category_id,
         i.quantity,
         p.low_stock_threshold
       FROM products p
       INNER JOIN inventory i ON i.product_id = p.id
       WHERE p.low_stock_threshold IS NOT NULL
         AND i.quantity <= p.low_stock_threshold
         AND p.store_id IS NULL AND NOT p.archived
       ORDER BY i.quantity ASC, p.name ASC`,
    );

    return result.rows;
  }

  async function changeStock(productId, quantity, userId, transactionType) {
    if (
      !Number.isSafeInteger(productId) ||
      productId <= 0 ||
      !Number.isSafeInteger(quantity) ||
      quantity <= 0 ||
      quantity > MAX_STOCK
    ) {
      throw new Error("Product ID and quantity must be positive integers");
    }

    if (!userId || !/^[1-9]\d*$/.test(String(userId))) {
      throw new Error("Valid authenticated user ID is required");
    }

    const client = await db.connect();

    let updatedInventory;

    try {
      await client.query("BEGIN");

      const inventoryResult = await client.query(
        `SELECT i.product_id, i.quantity
         FROM inventory i JOIN products p ON p.id = i.product_id
         WHERE i.product_id = $1 AND p.store_id IS NULL AND NOT p.archived
         FOR UPDATE OF p, i`,
        [productId],
      );

      if (inventoryResult.rowCount === 0) {
        if (transactionType === "increase") {
          throw createError("Product inventory not found", 404);
        }

        throw createError(
          "Product inventory not found or insufficient stock",
          409,
        );
      }

      const quantityBefore = inventoryResult.rows[0].quantity;

      let quantityAfter;

      if (transactionType === "increase") {
        if (quantityBefore > MAX_STOCK - quantity) {
          throw createError("Stock quantity limit exceeded", 409);
        }

        quantityAfter = quantityBefore + quantity;
      } else {
        if (quantityBefore < quantity) {
          throw createError(
            "Product inventory not found or insufficient stock",
            409,
          );
        }

        quantityAfter = quantityBefore - quantity;
      }

      const updateResult = await client.query(
        `UPDATE inventory
         SET quantity = $2,
             updated_at = CURRENT_TIMESTAMP
         WHERE product_id = $1
         RETURNING product_id, quantity, updated_at`,
        [productId, quantityAfter],
      );

      await client.query(
        `INSERT INTO inventory_transactions
          (product_id, performed_by, transaction_type, quantity,
           quantity_before, quantity_after)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          productId,
          userId,
          transactionType,
          quantity,
          quantityBefore,
          quantityAfter,
        ],
      );

      updatedInventory = updateResult.rows[0];

      await client.query("COMMIT");
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the original transaction error.
      }

      throw error;
    } finally {
      client.release();
    }

    // Publish only after the transaction has committed and
    // the database client has been released.
    try {
      await publishInventoryUpdatedFn({
        productId: updatedInventory.product_id,
        quantity: updatedInventory.quantity,
      });
    } catch {
      // Notification failure must not fail the stock operation.
    }

    return updatedInventory;
  }

  async function decreaseStock(productId, quantity, userId) {
    return changeStock(productId, quantity, userId, "decrease");
  }

  async function increaseStock(productId, quantity, userId) {
    return changeStock(productId, quantity, userId, "increase");
  }

  async function getInventoryTransactions({
    productId,
    limit = 20,
    offset = 0,
  }) {
    const values = [];
    let productFilter = "";

    if (productId !== undefined) {
      values.push(productId);
      productFilter = `AND t.product_id = $${values.length}`;
    }

    values.push(limit);
    const limitPlaceholder = `$${values.length}`;

    values.push(offset);
    const offsetPlaceholder = `$${values.length}`;

    const result = await db.query(
      `SELECT
         t.id, t.product_id, t.performed_by, t.transaction_type, t.quantity,
         t.quantity_before, t.quantity_after, t.created_at
       FROM inventory_transactions t JOIN products p ON p.id = t.product_id
       WHERE p.store_id IS NULL ${productFilter}
       ORDER BY t.created_at DESC, t.id DESC
       LIMIT ${limitPlaceholder}
       OFFSET ${offsetPlaceholder}`,
      values,
    );

    return result.rows;
  }

  return {
    getInventoryByProductId,
    getLowStockProducts,
    decreaseStock,
    increaseStock,
    getInventoryTransactions,
  };
}

const inventoryService = createInventoryService();

async function listInventory(limit, offset, db = pool) {
  const scope = "p.store_id IS NULL AND NOT p.archived";
  const [page, count] = await Promise.all([
    db.query(
      `SELECT p.id,p.name,p.sku,p.category_id,c.name AS category,p.price,
      i.quantity,p.low_stock_threshold
      FROM products p JOIN inventory i ON i.product_id=p.id
      JOIN categories c ON c.id=p.category_id
      WHERE ${scope} ORDER BY p.id LIMIT $1 OFFSET $2`,
      [limit, offset],
    ),
    db.query(`SELECT count(*)::int AS total FROM products p
      JOIN inventory i ON i.product_id=p.id WHERE ${scope}`),
  ]);
  return {
    products: page.rows,
    pagination: { limit, offset, total: count.rows[0].total },
  };
}

module.exports = {
  listInventory,
  createInventoryService,
  ...inventoryService,
};
