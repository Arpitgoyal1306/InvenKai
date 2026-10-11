const pool = require("../config/database");

async function getInventoryByProductId(productId) {
  const result = await pool.query(
    `SELECT product_id, quantity, created_at, updated_at
     FROM inventory
     WHERE product_id = $1`,
    [productId],
  );

  return result.rows[0] ?? null;
}

async function decreaseStock(productId, quantity) {
  if (
    !Number.isSafeInteger(productId) ||
    productId <= 0 ||
    !Number.isSafeInteger(quantity) ||
    quantity <= 0
  ) {
    throw new Error("Product ID and quantity must be positive integers");
  }

  const result = await pool.query(
    `UPDATE inventory
     SET quantity = quantity - $2,
         updated_at = CURRENT_TIMESTAMP
     WHERE product_id = $1
       AND quantity >= $2
     RETURNING product_id, quantity, updated_at`,
    [productId, quantity],
  );

  if (result.rowCount === 0) {
    throw new Error("Product inventory not found or insufficient stock");
  }

  return result.rows[0];
}

module.exports = {
  getInventoryByProductId,
  decreaseStock,
};
