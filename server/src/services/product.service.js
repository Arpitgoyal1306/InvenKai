const pool = require("../config/database");

const MAX_BIGINT = 9223372036854775807n;

const ALLOWED_PRODUCT_FIELDS = [
  "category_id",
  "name",
  "description",
  "sku",
  "price",
  "low_stock_threshold",
];

function createError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function isValidBigIntId(value) {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0;
  }

  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) {
    return false;
  }

  return BigInt(value) <= MAX_BIGINT;
}

function validateProductId(id) {
  if (!isValidBigIntId(id)) {
    throw createError("Product ID must be a positive integer");
  }
}

function validateProductPagination(limit, offset) {
  if (
    !Number.isSafeInteger(limit) ||
    limit <= 0 ||
    limit > 100 ||
    !Number.isSafeInteger(offset) ||
    offset < 0
  ) {
    throw createError("Invalid pagination values");
  }
}

function validateProductData(data, allowedFields, requireAll = false) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw createError("Invalid product data");
  }

  const invalidFields = Object.keys(data).filter(
    (field) => !allowedFields.includes(field),
  );

  if (invalidFields.length > 0) {
    throw createError(`Invalid fields: ${invalidFields.join(", ")}`);
  }

  if (requireAll) {
    for (const field of allowedFields) {
      if (
        !(field in data) &&
        field !== "description" &&
        field !== "low_stock_threshold"
      ) {
        throw createError(`${field} is required`);
      }
    }
  }

  if (Object.keys(data).length === 0) {
    throw createError("At least one product field is required");
  }

  if ("category_id" in data && !isValidBigIntId(data.category_id)) {
    throw createError("Category ID must be a positive integer");
  }

  if ("name" in data) {
    if (
      typeof data.name !== "string" ||
      !data.name.trim() ||
      data.name.trim().length > 200
    ) {
      throw createError(
        "Product name is required and must not exceed 200 characters",
      );
    }
  }

  if ("description" in data) {
    if (data.description !== null && typeof data.description !== "string") {
      throw createError("Description must be a string or null");
    }
  }

  if ("sku" in data) {
    if (
      typeof data.sku !== "string" ||
      !data.sku.trim() ||
      data.sku.trim().length > 100
    ) {
      throw createError("SKU is required and must not exceed 100 characters");
    }
  }

  const threshold = data.low_stock_threshold;
  if (
    "low_stock_threshold" in data &&
    threshold !== null &&
    (!Number.isInteger(threshold) || threshold < 0 || threshold > 2147483647)
  ) {
    throw createError("Enter a nonnegative integer or clear the threshold.");
  }

  if ("price" in data) {
    const price = data.price;

    if (
      typeof price !== "number" ||
      !Number.isFinite(price) ||
      price < 0 ||
      price > 99999999.99 ||
      Number(price.toFixed(2)) !== price
    ) {
      throw createError(
        "Price must be a non-negative number with at most two decimal places",
      );
    }
  }
}

// CREATE PRODUCT
async function createProduct(productData) {
  validateProductData(productData, ALLOWED_PRODUCT_FIELDS, true);

  const {
    category_id,
    name,
    description = null,
    sku,
    price,
    low_stock_threshold = null,
  } = productData;

  const client = await pool.connect();
  let operation = "product";

  try {
    await client.query("BEGIN");

    const result = await client.query(
      `INSERT INTO products (
        category_id,
        name,
        description,
        sku,
        price, low_stock_threshold
      )
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *`,
      [
        category_id,
        name.trim(),
        description === null ? null : description.trim() || null,
        sku.trim(),
        price,
        low_stock_threshold,
      ],
    );

    const product = result.rows[0];

    if (!product) {
      throw new Error("Product creation returned no record");
    }

    operation = "inventory";

    await client.query(
      `INSERT INTO inventory (product_id, quantity)
       VALUES ($1, 0)`,
      [product.id],
    );

    await client.query("COMMIT");

    return product;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      if (error && typeof error === "object") {
        error.rollbackError = rollbackError;
      }
    }

    if (operation === "product" && error?.code === "23505") {
      throw createError("A product with this SKU already exists", 409);
    }

    if (operation === "product" && error?.code === "23503") {
      throw createError("The specified category does not exist", 400);
    }

    throw error;
  } finally {
    client.release();
  }
}

// GET ALL PRODUCTS
async function getProducts(limit = 10, offset = 0, db = pool) {
  validateProductPagination(limit, offset);

  const result = await db.query(
    `SELECT *
     FROM products
     WHERE store_id IS NULL AND NOT archived
     ORDER BY id
     LIMIT $1
     OFFSET $2`,
    [limit, offset],
  );

  return result.rows;
}

// GET PRODUCT BY ID
async function getProductById(id) {
  validateProductId(id);

  const result = await pool.query(
    `SELECT *
     FROM products
     WHERE id = $1 AND store_id IS NULL AND NOT archived`,
    [id],
  );

  return result.rows[0] || null;
}

// UPDATE PRODUCT
async function updateProduct(id, productData) {
  validateProductId(id);
  validateProductData(productData, ALLOWED_PRODUCT_FIELDS);

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const existingResult = await client.query(
      `SELECT *
       FROM products
       WHERE id = $1 AND store_id IS NULL AND NOT archived
       FOR UPDATE`,
      [id],
    );

    if (existingResult.rows.length === 0) {
      throw createError("Product not found", 404);
    }

    const existingProduct = existingResult.rows[0];

    const updatedProduct = {
      category_id: existingProduct.category_id,
      name: existingProduct.name,
      description: existingProduct.description,
      sku: existingProduct.sku,
      price: Number(existingProduct.price),
      low_stock_threshold: existingProduct.low_stock_threshold ?? null,
      ...productData,
    };

    validateProductData(updatedProduct, ALLOWED_PRODUCT_FIELDS, true);

    const result = await client.query(
      `UPDATE products
       SET category_id = $1,
           name = $2,
           description = $3,
           sku = $4,
           price = $5,
           low_stock_threshold = $7,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $6
       RETURNING *`,
      [
        updatedProduct.category_id,
        updatedProduct.name.trim(),
        updatedProduct.description === null
          ? null
          : updatedProduct.description.trim() || null,
        updatedProduct.sku.trim(),
        updatedProduct.price,
        id,
        updatedProduct.low_stock_threshold,
      ],
    );

    await client.query("COMMIT");

    return result.rows[0];
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      if (error && typeof error === "object") {
        error.rollbackError = rollbackError;
      }
    }

    if (error?.code === "23505") {
      throw createError("A product with this SKU already exists", 409);
    }

    if (error?.code === "23503") {
      throw createError("The specified category does not exist", 400);
    }

    throw error;
  } finally {
    client.release();
  }
}

async function archiveProduct(id) {
  validateProductId(id);
  const {
    rows: [product],
  } = await pool.query(
    `UPDATE products SET archived=true,updated_at=NOW()
     WHERE id=$1 AND store_id IS NULL AND NOT archived
     RETURNING *`,
    [id],
  );
  if (!product) throw createError("Product not found", 404);
  return product;
}

async function countProducts(db = pool) {
  const { rows } = await db.query(
    "SELECT count(*)::int AS total FROM products WHERE store_id IS NULL AND NOT archived",
  );
  return rows[0].total;
}

module.exports = {
  createProduct,
  getProducts,
  getProductById,
  updateProduct,
  archiveProduct,
  countProducts,
  validateProductId,
  validateProductPagination,
};
