const pool = require("../config/database");

// Create a new supplier
async function createSupplier(supplierData) {
  if (
    !supplierData ||
    typeof supplierData !== "object" ||
    Array.isArray(supplierData)
  ) {
    const error = new Error("Invalid supplier data");
    error.statusCode = 400;
    throw error;
  }

  const { name, contact_name, email, phone } = supplierData;
  // Validate name
  if (
    typeof name !== "string" ||
    !name.trim() ||
    name.trim().length > 200
  ) {
    const error = new Error(
      "Supplier name is required and must not exceed 200 characters"
    );
    error.statusCode = 400;
    throw error;
  }

  // Validate contact name
  if (
    contact_name != null &&
    (typeof contact_name !== "string" || contact_name.trim().length > 100)
  ) {
    const error = new Error(
      "Contact name must be a string of at most 100 characters"
    );
    error.statusCode = 400;
    throw error;
  }

  // Validate email type
  if (email != null && typeof email !== "string") {
    const error = new Error("Email must be a string");
    error.statusCode = 400;
    throw error;
  }

  const normalizedEmail = email?.trim().toLowerCase() || null;

  if (
    normalizedEmail &&
    (
      normalizedEmail.length > 255 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)
    )
  ) {
    const error = new Error("Please provide a valid email address");
    error.statusCode = 400;
    throw error;
  }

  // Validate phone type
  if (phone != null && typeof phone !== "string") {
    const error = new Error("Phone must be a string");
    error.statusCode = 400;
    throw error;
  }

  const normalizedPhone = phone?.trim() || null;

  if (
    normalizedPhone &&
    (
      normalizedPhone.length > 30 ||
      !/^\+?[0-9\s().-]+$/.test(normalizedPhone) ||
      normalizedPhone.replace(/\D/g, "").length < 7 ||
      normalizedPhone.replace(/\D/g, "").length > 15
    )
  ) {
    const error = new Error("Please provide a valid phone number");
    error.statusCode = 400;
    throw error;
  }

  if (!normalizedEmail && !normalizedPhone) {
    const error = new Error(
      "At least one of email or phone is required"
    );
    error.statusCode = 400;
    throw error;
  }

  const result = await pool.query(
    `INSERT INTO suppliers (
      name,
      contact_name,
      email,
      phone
    )
    VALUES ($1, $2, $3, $4)
    RETURNING *`,
    [
      name.trim(),
      contact_name?.trim() || null,
      normalizedEmail,
      normalizedPhone,
    ]
  );

  return result.rows[0];
}

// Get all active suppliers with pagination
async function getSuppliers(limit = 10, offset = 0) {
  if (
    !Number.isSafeInteger(limit) ||
    limit <= 0 ||
    limit > 100 ||
    !Number.isSafeInteger(offset) ||
    offset < 0
  ) {
    const error = new Error("Invalid pagination values");
    error.statusCode = 400;
    throw error;
  }

  const result = await pool.query(
    `SELECT *
     FROM suppliers
     WHERE is_active = TRUE
     ORDER BY id
     LIMIT $1
     OFFSET $2`,
    [limit, offset]
  );

  return result.rows;
}

// Get one active supplier
async function getSupplierById(id) {
  if (!Number.isSafeInteger(id) || id <= 0) {
    const error = new Error("Supplier ID must be a positive integer");
    error.statusCode = 400;
    throw error;
  }

  const result = await pool.query(
    `SELECT *
     FROM suppliers
     WHERE id = $1
       AND is_active = TRUE`,
    [id]
  );

  return result.rows[0] || null;
}

// Update an existing supplier

async function updateSupplier(id, updates) {
  // Validate supplier ID
  if (!Number.isSafeInteger(id) || id <= 0) {
    const error = new Error("Supplier ID must be a positive integer");
    error.statusCode = 400;
    throw error;
  }

  // Allowed update fields
  const allowedFields = ["name", "contact_name", "email", "phone"];

  if (
    !updates ||
    typeof updates !== "object" ||
    Array.isArray(updates) ||
    Object.keys(updates).length === 0
  ) {
    const error = new Error("At least one field is required for update");
    error.statusCode = 400;
    throw error;
  }

  const invalidFields = Object.keys(updates).filter(
    (field) => !allowedFields.includes(field)
  );

  if (invalidFields.length > 0) {
    const error = new Error(
      `Invalid fields: ${invalidFields.join(", ")}`
    );
    error.statusCode = 400;
    throw error;
  }

  const client = await pool.connect();
  let transactionStarted = false;

  try {
    // Start transaction
    await client.query("BEGIN");
    transactionStarted = true;

    // Lock the supplier row until the transaction finishes
    const existingResult = await client.query(
      `SELECT *
       FROM suppliers
       WHERE id = $1
         AND is_active = TRUE
       FOR UPDATE`,
      [id]
    );

    const existingSupplier = existingResult.rows[0];

    if (!existingSupplier) {
      await client.query("COMMIT");
      transactionStarted = false;
      return null;
    }

    // Merge updates with the latest locked database values
    const updatedSupplier = {
      ...existingSupplier,
      ...updates,
    };

    // Validate name
    if (
      typeof updatedSupplier.name !== "string" ||
      !updatedSupplier.name.trim() ||
      updatedSupplier.name.trim().length > 200
    ) {
      const error = new Error(
        "Supplier name is required and must not exceed 200 characters"
      );
      error.statusCode = 400;
      throw error;
    }

    // Validate contact name
    if (
      updatedSupplier.contact_name != null &&
      (
        typeof updatedSupplier.contact_name !== "string" ||
        updatedSupplier.contact_name.trim().length > 100
      )
    ) {
      const error = new Error(
        "Contact name must be a string of at most 100 characters"
      );
      error.statusCode = 400;
      throw error;
    }

    // Validate email
    if (
      updatedSupplier.email != null &&
      typeof updatedSupplier.email !== "string"
    ) {
      const error = new Error("Email must be a string");
      error.statusCode = 400;
      throw error;
    }

    const normalizedEmail =
      updatedSupplier.email?.trim().toLowerCase() || null;

    if (
      normalizedEmail &&
      (
        normalizedEmail.length > 255 ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)
      )
    ) {
      const error = new Error("Please provide a valid email address");
      error.statusCode = 400;
      throw error;
    }

    // Validate phone
    if (
      updatedSupplier.phone != null &&
      typeof updatedSupplier.phone !== "string"
    ) {
      const error = new Error("Phone must be a string");
      error.statusCode = 400;
      throw error;
    }

    const normalizedPhone =
      updatedSupplier.phone?.trim() || null;

    if (
      normalizedPhone &&
      (
        normalizedPhone.length > 30 ||
        !/^\+?[0-9\s().-]+$/.test(normalizedPhone) ||
        normalizedPhone.replace(/\D/g, "").length < 7 ||
        normalizedPhone.replace(/\D/g, "").length > 15
      )
    ) {
      const error = new Error("Please provide a valid phone number");
      error.statusCode = 400;
      throw error;
    }

    // Require at least one contact method
    if (!normalizedEmail && !normalizedPhone) {
      const error = new Error(
        "At least one of email or phone is required"
      );
      error.statusCode = 400;
      throw error;
    }

    // Update supplier inside the same transaction
    const result = await client.query(
      `UPDATE suppliers
       SET name = $1,
           contact_name = $2,
           email = $3,
           phone = $4,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $5
         AND is_active = TRUE
       RETURNING *`,
      [
        updatedSupplier.name.trim(),
        updatedSupplier.contact_name?.trim() || null,
        normalizedEmail,
        normalizedPhone,
        id,
      ]
    );

    // Commit transaction
    await client.query("COMMIT");
    transactionStarted = false;

    return result.rows[0] || null;
  } catch (error) {
    if (transactionStarted) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        // Preserve the original error if rollback also fails
      }
    }

    throw error;
  } finally {
    // Always release the database connection
    client.release();
  }
}


const deleteSupplier = async (id) => {
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw Object.assign(
      new Error("Invalid supplier ID"),
      { statusCode: 400 }
    );
  }

  const result = await pool.query(
    `UPDATE suppliers
     SET is_active = FALSE,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $1
       AND is_active = TRUE
     RETURNING *`,
    [id]
  );

  return result.rows[0] || null;
};

module.exports = {
  createSupplier,
  getSuppliers,
  getSupplierById,
  updateSupplier,
  deleteSupplier,
};
