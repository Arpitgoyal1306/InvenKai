const pool = require("../config/database");
const { publishInventoryUpdated } = require("./inventory-events.service");

const MAX_STOCK = 2147483647;
const MAX_BIGINT = 9223372036854775807n;
const MAX_ITEMS_PER_ORDER = 50;

function createError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function normalizeId(value) {
  if (typeof value !== "string" && typeof value !== "number") {
    throw createError("Invalid user or product ID", 400);
  }

  if (typeof value === "number" && !Number.isSafeInteger(value)) {
    throw createError("Invalid user or product ID", 400);
  }

  const id = String(value);

  if (!/^[1-9]\d*$/.test(id)) {
    throw createError("Invalid user or product ID", 400);
  }

  if (BigInt(id) > MAX_BIGINT) {
    throw createError("Invalid user or product ID", 400);
  }

  return id;
}

function validateOrderItems(items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw createError("Order must contain at least one item", 400);
  }

  if (items.length > MAX_ITEMS_PER_ORDER) {
    throw createError(
      `An order cannot contain more than ${MAX_ITEMS_PER_ORDER} items`,
      400,
    );
  }

  const seenProductIds = new Set();

  return items.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw createError("Invalid order item", 400);
    }

    const productId = normalizeId(item.productId);
    const quantity = item.quantity;

    if (seenProductIds.has(productId)) {
      throw createError("Duplicate products are not allowed in an order", 400);
    }

    seenProductIds.add(productId);

    if (
      !Number.isSafeInteger(quantity) ||
      quantity <= 0 ||
      quantity > MAX_STOCK
    ) {
      throw createError(
        "Quantity must be a positive integer within the allowed limit",
        400,
      );
    }

    return { productId, quantity };
  });
}

function validatePagination(options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw createError("Invalid pagination options", 400);
  }

  const { page = 1, limit = 10 } = options;

  if (!Number.isSafeInteger(page) || page < 1) {
    throw createError("Page must be a positive integer", 400);
  }

  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw createError("Limit must be between 1 and 100", 400);
  }

  const offset = (page - 1) * limit;

  if (!Number.isSafeInteger(offset)) {
    throw createError("Pagination offset is too large", 400);
  }

  return { page, limit, offset };
}

// Retrieve all orders belonging to a specific user.
async function getUserOrders(userId, options = {}, db = pool) {
  const normalizedUserId = normalizeId(userId);
  const { page, limit, offset } = validatePagination(options);

  // Verify that the user exists.
  const userResult = await db.query(
    `SELECT id
     FROM users
     WHERE id = $1`,
    [normalizedUserId],
  );

  if (userResult.rowCount === 0) {
    throw createError("User not found", 404);
  }

  // Get the total number of orders.
  const countResult = await db.query(
    `SELECT COUNT(*) AS total
     FROM orders
     WHERE user_id = $1`,
    [normalizedUserId],
  );

  const total = Number(countResult.rows[0].total);

  // Get paginated orders and their item counts.
  const ordersResult = await db.query(
    `SELECT
       o.id,
       o.user_id,
       o.status,
       o.total_amount,
       o.created_at,
       o.updated_at,
       COUNT(oi.id)::INTEGER AS item_count
     FROM orders o
     LEFT JOIN order_items oi
       ON oi.order_id = o.id
     WHERE o.user_id = $1
     GROUP BY o.id
     ORDER BY o.created_at DESC, o.id DESC
     LIMIT $2 OFFSET $3`,
    [normalizedUserId, limit, offset],
  );

  return {
    orders: ordersResult.rows,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  };
}

async function getOrderById(userId, orderId, db = pool) {
  const normalizedUserId = normalizeId(userId);
  const normalizedOrderId = normalizeId(orderId);

  const result = await db.query(
    `SELECT
       o.id,
       o.user_id,
       o.status,
       o.total_amount,
       o.created_at,
       o.updated_at,
       oi.id AS item_id,
       oi.product_id,
       oi.product_name,
       oi.sku,
       oi.unit_price,
       oi.quantity,
       oi.line_total
     FROM orders o
     LEFT JOIN order_items oi
       ON oi.order_id = o.id
     WHERE o.id = $1
       AND o.user_id = $2
     ORDER BY oi.id`,
    [normalizedOrderId, normalizedUserId],
  );

  if (result.rowCount === 0) {
    throw createError("Order not found", 404);
  }

  const firstRow = result.rows[0];

  const order = {
    id: firstRow.id,
    user_id: firstRow.user_id,
    status: firstRow.status,
    total_amount: firstRow.total_amount,
    created_at: firstRow.created_at,
    updated_at: firstRow.updated_at,
    items: [],
  };

  for (const row of result.rows) {
    // LEFT JOIN returns NULL item columns if an order has no items.
    if (row.item_id === null) {
      continue;
    }

    order.items.push({
      id: row.item_id,
      product_id: row.product_id,
      product_name: row.product_name,
      sku: row.sku,
      unit_price: row.unit_price,
      quantity: row.quantity,
      line_total: row.line_total,
    });
  }

  return order;
}


async function createOrder(
  userId,
  requestedItems,
  db = pool,
  publishInventoryUpdatedFn = publishInventoryUpdated,
) {
  const normalizedUserId = normalizeId(userId);
  const items = validateOrderItems(requestedItems);

  const client = await db.connect();

  let clientReleased = false;
  let orderResponse;
  const inventoryUpdates = [];

  try {
    await client.query("BEGIN");

    const productIds = items.map((item) => item.productId);

    // Lock products and inventory in deterministic order.
    const productResult = await client.query(
      `SELECT
         p.id,
         p.name,
         p.sku,
         p.price,
         i.quantity AS available_quantity
       FROM products p
       INNER JOIN inventory i ON i.product_id = p.id
       WHERE p.id = ANY($1::bigint[])
       ORDER BY p.id
       FOR UPDATE OF p, i`,
      [productIds],
    );

    if (productResult.rowCount !== items.length) {
      throw createError(
        "One or more products or their inventory records were not found",
        404,
      );
    }

    const productsById = new Map(
      productResult.rows.map((product) => [String(product.id), product]),
    );

    // Validate stock before creating the order.
    for (const item of items) {
      const product = productsById.get(item.productId);

      if (product.available_quantity < item.quantity) {
        throw createError(
          `Insufficient stock for product ${item.productId}`,
          409,
        );
      }
    }

    // Create the order.
    let orderResult;

    try {
      orderResult = await client.query(
        `INSERT INTO orders (user_id, status, total_amount)
         VALUES ($1, 'placed', 0)
         RETURNING id, user_id, status, total_amount,
                   created_at, updated_at`,
        [normalizedUserId],
      );
    } catch (error) {
      if (error.code === "23503") {
        throw createError("Authenticated user no longer exists", 401);
      }

      throw error;
    }

    const order = orderResult.rows[0];

    // Save order item snapshots.
    for (const item of items) {
      const product = productsById.get(item.productId);

      await client.query(
        `INSERT INTO order_items
          (order_id, product_id, product_name, sku, unit_price, quantity)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          order.id,
          product.id,
          product.name,
          product.sku,
          product.price,
          item.quantity,
        ],
      );
    }

    // Deduct inventory and record stock movements.
    for (const item of items) {
      const product = productsById.get(item.productId);
      const quantityBefore = product.available_quantity;

      const updateResult = await client.query(
        `UPDATE inventory
         SET quantity = quantity - $2,
             updated_at = CURRENT_TIMESTAMP
         WHERE product_id = $1
           AND quantity >= $2
         RETURNING quantity`,
        [item.productId, item.quantity],
      );

      if (updateResult.rowCount !== 1) {
        throw createError(
          `Insufficient stock for product ${item.productId}`,
          409,
        );
      }

      const quantityAfter = updateResult.rows[0].quantity;

      await client.query(
        `INSERT INTO inventory_transactions
          (product_id, performed_by, transaction_type, quantity,
           quantity_before, quantity_after, order_id)
         VALUES ($1, $2, 'decrease', $3, $4, $5, $6)`,
        [
          item.productId,
          normalizedUserId,
          item.quantity,
          quantityBefore,
          quantityAfter,
          order.id,
        ],
      );

      // Keep event data until the whole order commits.
      inventoryUpdates.push({
        productId: item.productId,
        quantity: quantityAfter,
      });
    }

    // Calculate the final amount.
    const totalResult = await client.query(
      `UPDATE orders
       SET total_amount = (
         SELECT COALESCE(SUM(line_total), 0)
         FROM order_items
         WHERE order_id = $1
       ),
       updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING id, user_id, status, total_amount,
                 created_at, updated_at`,
      [order.id],
    );

    // Fetch saved order items.
    const itemsResult = await client.query(
      `SELECT
         id,
         product_id,
         product_name,
         sku,
         unit_price,
         quantity,
         line_total
       FROM order_items
       WHERE order_id = $1
       ORDER BY id`,
      [order.id],
    );

    // Commit the complete order and all inventory deductions.
    await client.query("COMMIT");

    orderResponse = {
      ...totalResult.rows[0],
      items: itemsResult.rows,
    };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      // Discard the connection if transaction state is uncertain.
      client.release(rollbackError);
      clientReleased = true;
    }

    throw error;
  } finally {
    if (!clientReleased) {
      client.release();
    }
  }

  // Publish only after the entire order transaction commits
  // and the PostgreSQL client has been released.
  for (const update of inventoryUpdates) {
    try {
      await publishInventoryUpdatedFn(update);
    } catch {
      // Notification failures must not fail a committed order.
    }
  }

  return orderResponse;
}


module.exports = {
  createOrder,
  getUserOrders,
  getOrderById,
};
