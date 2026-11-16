const pool = require("../config/database");

function createOrderReceiptProcessor({ db = pool } = {}) {
  return async function processOrderReceipt(job) {
    const orderId = job.data?.orderId;
    if (!orderId || !/^[1-9]\d*$/.test(String(orderId))) {
      throw new Error("Order receipt job requires a valid orderId");
    }

    const result = await db.query(
      `SELECT o.id AS order_id, o.user_id, o.total_amount,
              oi.id AS item_id, oi.product_id, oi.product_name, oi.sku,
              oi.unit_price, oi.quantity, oi.line_total
       FROM orders o
       LEFT JOIN order_items oi ON oi.order_id = o.id
       WHERE o.id = $1
       ORDER BY oi.id`,
      [String(orderId)],
    );
    if (result.rowCount === 0) throw new Error(`Order ${orderId} was not found`);

    const first = result.rows[0];
    const items = result.rows.filter((row) => row.item_id !== null).map((row) => ({
      orderItemId: row.item_id,
      productId: row.product_id,
      productName: row.product_name,
      sku: row.sku,
      unitPrice: row.unit_price,
      quantity: row.quantity,
      lineTotal: row.line_total,
    }));

    const inserted = await db.query(
      `INSERT INTO receipts (order_id, receipt_number, user_id, total_amount, items)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       ON CONFLICT (order_id) DO NOTHING
       RETURNING id, order_id, receipt_number, issued_at`,
      [first.order_id, `INV-${first.order_id}`, first.user_id,
        first.total_amount, JSON.stringify(items)],
    );
    if (inserted.rowCount === 1) return inserted.rows[0];

    const existing = await db.query(
      `SELECT id, order_id, receipt_number, issued_at
       FROM receipts WHERE order_id = $1`,
      [first.order_id],
    );
    return existing.rows[0];
  };
}

module.exports = { createOrderReceiptProcessor };
