const pool = require("../config/database");

const MAX_STOCK = 2147483647;

function createError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

async function getInventoryByProductId(productId) {
  const result = await pool.query(
    `SELECT product_id, quantity, created_at, updated_at
     FROM inventory
     WHERE product_id = $1`,
    [productId],
  );

  return result.rows[0] ?? null;
}

// Get products whose current stock is at or below their threshold.
async function getLowStockProducts(db = pool) {
  const result = await db.query(
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

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Lock the inventory row to prevent concurrent stock changes
    // from calculating their before/after quantities incorrectly.
    const inventoryResult = await client.query(
      `SELECT product_id, quantity
       FROM inventory
       WHERE product_id = $1
       FOR UPDATE`,
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

    await client.query("COMMIT");

    return updateResult.rows[0];
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      // Preserve the original operation error.
    }

    throw error;
  } finally {
    client.release();
  }
}

async function decreaseStock(productId, quantity, userId) {
  return changeStock(productId, quantity, userId, "decrease");
}

async function increaseStock(productId, quantity, userId) {
  return changeStock(productId, quantity, userId, "increase");
}

async function getInventoryTransactions({ productId, limit = 20, offset = 0 }) {
  const values = [];
  let whereClause = "";

  if (productId !== undefined) {
    values.push(productId);
    whereClause = `WHERE product_id = $${values.length}`;
  }

  values.push(limit);
  const limitPlaceholder = `$${values.length}`;

  values.push(offset);
  const offsetPlaceholder = `$${values.length}`;

  const result = await pool.query(
    `SELECT
       id,
       product_id,
       performed_by,
       transaction_type,
       quantity,
       quantity_before,
       quantity_after,
       created_at
     FROM inventory_transactions
     ${whereClause}
     ORDER BY created_at DESC, id DESC
     LIMIT ${limitPlaceholder}
     OFFSET ${offsetPlaceholder}`,
    values,
  );

  return result.rows;
}

module.exports = {
  getInventoryByProductId,
  getLowStockProducts,
  decreaseStock,
  increaseStock,
  getInventoryTransactions,
};
