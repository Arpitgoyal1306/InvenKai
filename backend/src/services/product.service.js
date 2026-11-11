const pool = require("../config/database");

const MAX_BIGINT = 9223372036854775807n;

const ALLOWED_PRODUCT_FIELDS = [
  "category_id",
  "name",
  "description",
  "sku",
  "price",
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
      if (!(field in data) && field !== "description") {
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

  const { category_id, name, description = null, sku, price } = productData;

  try {
    const result = await pool.query(
      `INSERT INTO products (
        category_id,
        name,
        description,
        sku,
        price
      )
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *`,
      [
        category_id,
        name.trim(),
        description?.trim() || null,
        sku.trim(),
        price,
      ],
    );

    return result.rows[0];
  } catch (error) {
    if (error.code === "23505") {
      throw createError("A product with this SKU already exists", 409);
    }

    if (error.code === "23503") {
      throw createError("The specified category does not exist", 400);
    }

    throw error;
  }
}

// GET ALL PRODUCTS
async function getProducts(limit = 10, offset = 0) {
  validateProductPagination(limit, offset);

  const result = await pool.query(
    `SELECT *
     FROM products
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
     WHERE id = $1`,
    [id],
  );

  return result.rows[0] || null;
}

// UPDATE PRODUCT
async function updateProduct(id, productData) {
  validateProductId(id);

  // Validate fields supplied in the PATCH request.
  validateProductData(productData, ALLOWED_PRODUCT_FIELDS);

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Lock the product row to prevent concurrent updates.
    const existingResult = await client.query(
      `SELECT *
       FROM products
       WHERE id = $1
       FOR UPDATE`,
      [id],
    );

    if (existingResult.rows.length === 0) {
      throw createError("Product not found", 404);
    }

    const existingProduct = existingResult.rows[0];

    // Merge existing values with the supplied fields.
    const updatedProduct = {
      category_id: existingProduct.category_id,
      name: existingProduct.name,
      description: existingProduct.description,
      sku: existingProduct.sku,
      price: Number(existingProduct.price),
      ...productData,
    };

    // Validate the complete product after merging.
    validateProductData(updatedProduct, ALLOWED_PRODUCT_FIELDS, true);

    const result = await client.query(
      `UPDATE products
       SET category_id = $1,
           name = $2,
           description = $3,
           sku = $4,
           price = $5,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $6
       RETURNING *`,
      [
        updatedProduct.category_id,
        updatedProduct.name.trim(),
        updatedProduct.description?.trim() || null,
        updatedProduct.sku.trim(),
        updatedProduct.price,
        id,
      ],
    );

    await client.query("COMMIT");

    return result.rows[0];
  } catch (error) {
    // Attempt rollback without replacing the original error.
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      if (error instanceof Error) {
        error.rollbackError = rollbackError;
      }
    }

    if (error.code === "23505") {
      throw createError("A product with this SKU already exists", 409);
    }

    if (error.code === "23503") {
      throw createError("The specified category does not exist", 400);
    }

    throw error;
  } finally {
    client.release();
  }
}

// DELETE PRODUCT
async function deleteProduct(id) {
  validateProductId(id);

  try {
    const result = await pool.query(
      `DELETE FROM products
       WHERE id = $1
       RETURNING *`,
      [id],
    );

    if (result.rows.length === 0) {
      throw createError("Product not found", 404);
    }

    return result.rows[0];
  } catch (error) {
    if (error.statusCode) {
      throw error;
    }

    if (error.code === "23503" || error.code === "23001") {
      throw createError(
        "Cannot delete product because it has associated inventory, transaction history, or supplier records",
        409,
      );
    }

    throw error;
  }
}

module.exports = {
  createProduct,
  getProducts,
  getProductById,
  updateProduct,
  deleteProduct,
  validateProductId,
  validateProductPagination,
};
