
const express = require("express");

const authenticateToken = require("../middleware/auth.middleware");
const authorizeRoles = require("../middleware/authorize-roles");

const {
  createSupplier,
  getSuppliers,
  getSupplierById,
  updateSupplier,
  deleteSupplier,
} = require("../services/supplier.service");

const router = express.Router();

// Create a supplier.
// Only inventory managers and admins can create suppliers.
router.post(
  "/",
  authenticateToken,
  authorizeRoles("inventory_manager", "admin"),
  async (req, res) => {
    try {
      const supplier = await createSupplier(req.body);

      return res.status(201).json({
        message: "Supplier created successfully",
        supplier,
      });
    } catch (error) {
      if (error.statusCode === 400) {
        return res.status(400).json({
          message: error.message,
        });
      }

      return res.status(500).json({
        message: "Failed to create supplier",
      });
    }
  }
);

// Get all active suppliers with pagination.
// Any authenticated user can view suppliers.
router.get("/", authenticateToken, async (req, res) => {
  const limit = req.query.limit === undefined
    ? 10
    : Number(req.query.limit);

  const offset = req.query.offset === undefined
    ? 0
    : Number(req.query.offset);

  try {
    const suppliers = await getSuppliers(limit, offset);

    return res.status(200).json({
      suppliers,
      pagination: {
        limit,
        offset,
      },
    });
  } catch (error) {
    if (error.statusCode === 400) {
      return res.status(400).json({
        message: error.message,
      });
    }

    return res.status(500).json({
      message: "Failed to retrieve suppliers",
    });
  }
});

// Get a supplier by ID.
// Any authenticated user can view a supplier.
router.get("/:id", authenticateToken, async (req, res) => {
  const id = Number(req.params.id);

  if (!Number.isSafeInteger(id) || id <= 0) {
    return res.status(400).json({
      message: "Supplier ID must be a positive integer",
    });
  }

  try {
    const supplier = await getSupplierById(id);

    if (!supplier) {
      return res.status(404).json({
        message: "Supplier not found",
      });
    }

    return res.status(200).json({ supplier });
  } catch (error) {
    return res.status(500).json({
      message: "Failed to retrieve supplier",
    });
  }
});

// Update a supplier.
// Only inventory managers and admins can update suppliers.
router.patch(
  "/:id",
  authenticateToken,
  authorizeRoles("inventory_manager", "admin"),
  async (req, res) => {
    const id = Number(req.params.id);

    if (!Number.isSafeInteger(id) || id <= 0) {
      return res.status(400).json({
        message: "Supplier ID must be a positive integer",
      });
    }

    try {
      const supplier = await updateSupplier(id, req.body);

      if (!supplier) {
        return res.status(404).json({
          message: "Supplier not found",
        });
      }

      return res.status(200).json({
        message: "Supplier updated successfully",
        supplier,
      });
    } catch (error) {
      if (error.statusCode === 400) {
        return res.status(400).json({
          message: error.message,
        });
      }

      return res.status(500).json({
        message: "Failed to update supplier",
      });
    }
  }
);

// Soft-delete a supplier.
// Only admins can delete suppliers.
router.delete(
  "/:id",
  authenticateToken,
  authorizeRoles("admin"),
  async (req, res) => {
    const id = Number(req.params.id);

    if (!Number.isSafeInteger(id) || id <= 0) {
      return res.status(400).json({
        message: "Supplier ID must be a positive integer",
      });
    }

    try {
      const supplier = await deleteSupplier(id);

      if (!supplier) {
        return res.status(404).json({
          message: "Supplier not found",
        });
      }

      return res.status(200).json({
        message: "Supplier deleted successfully",
        supplier,
      });
    } catch (error) {
      return res.status(500).json({
        message: "Failed to delete supplier",
      });
    }
  }
);

module.exports = router;
