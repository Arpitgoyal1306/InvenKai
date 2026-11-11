const express = require("express");

const authenticateToken = require("../middleware/auth.middleware");
const authorizeRoles = require("../middleware/authorize-roles");

const {
  createProduct,
  updateProduct,
  deleteProduct,
} = require("../services/product.service");

const productCache = require("../services/product-cache.service");

const router = express.Router();

// Create a product.
// Only inventory managers and admins can create products.
router.post(
  "/",
  authenticateToken,
  authorizeRoles("inventory_manager", "admin"),
  async (req, res) => {
    try {
      const product = await createProduct(req.body);

      // Invalidate cached catalog after successful creation.
      await productCache.invalidateProductCatalog();

      return res.status(201).json({
        message: "Product created successfully",
        product,
      });
    } catch (error) {
      if (error.statusCode === 400 || error.statusCode === 409) {
        return res.status(error.statusCode).json({
          message: error.message,
        });
      }

      return res.status(500).json({
        message: "Failed to create product",
      });
    }
  },
);

// Get all products with pagination.
// Any authenticated user can view products.
router.get("/", authenticateToken, async (req, res) => {
  const limit = req.query.limit === undefined ? 10 : Number(req.query.limit);
  const offset = req.query.offset === undefined ? 0 : Number(req.query.offset);

  try {
    const products = await productCache.getCachedProducts(limit, offset);

    return res.status(200).json({
      products,
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
      message: "Failed to retrieve products",
    });
  }
});

// Get a product by ID.
// Any authenticated user can view a product.
router.get("/:id", authenticateToken, async (req, res) => {
  const { id } = req.params;

  try {
    const product = await productCache.getCachedProductById(id);

    if (!product) {
      return res.status(404).json({
        message: "Product not found",
      });
    }

    return res.status(200).json({ product });
  } catch (error) {
    if (error.statusCode === 400) {
      return res.status(400).json({
        message: error.message,
      });
    }

    return res.status(500).json({
      message: "Failed to retrieve product",
    });
  }
});

// Update a product.
// Only inventory managers and admins can update products.
router.patch(
  "/:id",
  authenticateToken,
  authorizeRoles("inventory_manager", "admin"),
  async (req, res) => {
    const { id } = req.params;

    try {
      const product = await updateProduct(id, req.body);

      // Invalidate cached catalog after successful update.
      await productCache.invalidateProductCatalog();

      return res.status(200).json({
        message: "Product updated successfully",
        product,
      });
    } catch (error) {
      if ([400, 404, 409].includes(error.statusCode)) {
        return res.status(error.statusCode).json({
          message: error.message,
        });
      }

      return res.status(500).json({
        message: "Failed to update product",
      });
    }
  },
);

// Permanently delete a product.
// Only admins can delete products.
router.delete(
  "/:id",
  authenticateToken,
  authorizeRoles("admin"),
  async (req, res) => {
    const { id } = req.params;

    try {
      const product = await deleteProduct(id);

      // Invalidate cached catalog after successful deletion.
      await productCache.invalidateProductCatalog();

      return res.status(200).json({
        message: "Product deleted successfully",
        product,
      });
    } catch (error) {
      if ([400, 404, 409].includes(error.statusCode)) {
        return res.status(error.statusCode).json({
          message: error.message,
        });
      }

      return res.status(500).json({
        message: "Failed to delete product",
      });
    }
  },
);

module.exports = router;
