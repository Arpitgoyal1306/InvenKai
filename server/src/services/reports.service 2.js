const pool = require("../config/database");
const { getLowStockProducts } = require("./inventory.service");

// Check whether a date is a real date in YYYY-MM-DD format.
function isValidDate(value) {
  if (typeof value !== "string") {
    return false;
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const date = new Date(`${value}T00:00:00.000Z`);

  return !Number.isNaN(date.getTime()) &&
    date.toISOString().slice(0, 10) === value;
}

// Validate the requested stock movement date range.
function validateDateRange(startDate, endDate) {
  if (!isValidDate(startDate) || !isValidDate(endDate)) {
    const error = new Error(
      "startDate and endDate must be valid dates in YYYY-MM-DD format"
    );
    error.statusCode = 400;
    throw error;
  }

  if (endDate < startDate) {
    const error = new Error(
      "endDate must be greater than or equal to startDate"
    );
    error.statusCode = 400;
    throw error;
  }
}

// 1. Overall stock summary.
async function getStockSummary(db = pool) {
  const result = await db.query(`
    SELECT
      COUNT(p.id)::INTEGER AS product_count,
      COUNT(i.product_id)::INTEGER AS products_with_inventory,
      (
        COUNT(p.id) - COUNT(i.product_id)
      )::INTEGER AS products_without_inventory,
      COALESCE(SUM(i.quantity), 0)::BIGINT AS total_stock_quantity
    FROM products p
    LEFT JOIN inventory i
      ON i.product_id = p.id
  `);

  const summary = result.rows[0];

  return {
    product_count: Number(summary.product_count),
    products_with_inventory: Number(summary.products_with_inventory),
    products_without_inventory: Number(summary.products_without_inventory),
    total_stock_quantity: Number(summary.total_stock_quantity),
  };
}

// 2. Low-stock report.
// Reuses the existing Issue #13 implementation.
async function getLowStockSummary(db = pool) {
  const products = await getLowStockProducts(db);

  return {
    count: products.length,
    products,
  };
}

// 3. Category-wise stock report.
async function getCategoryStock(categoryId, db = pool) {
  let query = `
    SELECT
      c.id AS category_id,
      c.name AS category_name,
      COUNT(DISTINCT p.id)::INTEGER AS product_count,
      COUNT(DISTINCT i.product_id)::INTEGER AS products_with_inventory,
      COALESCE(SUM(i.quantity), 0)::BIGINT AS total_stock_quantity
    FROM categories c
    LEFT JOIN products p
      ON p.category_id = c.id
    LEFT JOIN inventory i
      ON i.product_id = p.id
  `;

  const values = [];

  if (categoryId !== undefined) {
    const parsedCategoryId = Number(categoryId);

    if (
      !Number.isInteger(parsedCategoryId) ||
      parsedCategoryId <= 0
    ) {
      const error = new Error("categoryId must be a positive integer");
      error.statusCode = 400;
      throw error;
    }

    query += " WHERE c.id = $1";
    values.push(parsedCategoryId);
  }

  query += `
    GROUP BY c.id, c.name
    ORDER BY c.name ASC
  `;

  const result = await db.query(query, values);

  return {
    categories: result.rows.map((category) => ({
      category_id: Number(category.category_id),
      category_name: category.category_name,
      product_count: Number(category.product_count),
      products_with_inventory: Number(category.products_with_inventory),
      total_stock_quantity: Number(category.total_stock_quantity),
    })),
  };
}

// 4. Stock movement report for an inclusive date range.
async function getStockMovement(startDate, endDate, db = pool) {
  validateDateRange(startDate, endDate);

  const values = [startDate, endDate];

  // Overall stock added and removed during the date range.
  const totalsResult = await db.query(
    `
      SELECT
        COALESCE(
          SUM(quantity) FILTER (
            WHERE transaction_type = 'increase'
          ),
          0
        ) AS total_added,
        COALESCE(
          SUM(quantity) FILTER (
            WHERE transaction_type = 'decrease'
          ),
          0
        ) AS total_removed
      FROM inventory_transactions
      WHERE created_at >= (
        $1::date::timestamp AT TIME ZONE 'UTC'
      )
      AND created_at < (
        ($2::date + INTERVAL '1 day')::timestamp
        AT TIME ZONE 'UTC'
      )
    `,
    values
  );

  // Daily stock movement during the same date range.
  const dailyResult = await db.query(
    `
      SELECT
        TO_CHAR(
            (created_at AT TIME ZONE 'UTC')::date,
            'YYYY-MM-DD'
        ) AS date,
        COALESCE(
          SUM(quantity) FILTER (
            WHERE transaction_type = 'increase'
          ),
          0
        ) AS stock_added,
        COALESCE(
          SUM(quantity) FILTER (
            WHERE transaction_type = 'decrease'
          ),
          0
        ) AS stock_removed
      FROM inventory_transactions
      WHERE created_at >= (
        $1::date::timestamp AT TIME ZONE 'UTC'
      )
      AND created_at < (
        ($2::date + INTERVAL '1 day')::timestamp
        AT TIME ZONE 'UTC'
      )
      GROUP BY (created_at AT TIME ZONE 'UTC')::date
      ORDER BY date ASC
    `,
    values
  );

  const totalAdded = Number(totalsResult.rows[0].total_added);
  const totalRemoved = Number(totalsResult.rows[0].total_removed);

  return {
    start_date: startDate,
    end_date: endDate,
    total_added: totalAdded,
    total_removed: totalRemoved,
    net_change: totalAdded - totalRemoved,
    daily: dailyResult.rows.map((day) => {
      const stockAdded = Number(day.stock_added);
      const stockRemoved = Number(day.stock_removed);

      return {
        date: day.date,
        stock_added: stockAdded,
        stock_removed: stockRemoved,
        net_change: stockAdded - stockRemoved,
      };
    }),
  };
}

module.exports = {
  getStockSummary,
  getLowStockSummary,
  getCategoryStock,
  getStockMovement,
};
