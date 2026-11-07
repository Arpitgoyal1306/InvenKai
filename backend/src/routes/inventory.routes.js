const express = require("express");
const authenticateToken = require("../middleware/auth.middleware");
const authorizeRoles = require("../middleware/authorize-roles");

const {
  getInventoryByProductId,
  getLowStockProducts,
  decreaseStock,
  increaseStock,
  getInventoryTransactions,
} = require("../services/inventory.service");

const router = express.Router();

// Get inventory transaction history.
router.get("/history", authenticateToken, async (req, res) => {
  try {
    const productId =
      req.query.productId === undefined
        ? undefined
        : Number(req.query.productId);

    const limit = req.query.limit === undefined ? 20 : Number(req.query.limit);
    const offset =
      req.query.offset === undefined ? 0 : Number(req.query.offset);

    if (
      (productId !== undefined &&
        (!Number.isSafeInteger(productId) || productId <= 0)) ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      !Number.isSafeInteger(offset) ||
      offset < 0
    ) {
      return res.status(400).json({
        message: "Invalid productId, limit, or offset",
      });
    }

    const transactions = await getInventoryTransactions({
      productId,
      limit,
      offset,
    });

    return res.status(200).json({
      transactions,
      pagination: { limit, offset },
    });
  } catch (error) {
    console.error("Failed to fetch inventory history:", error);

    return res.status(500).json({
      message: "Failed to fetch inventory history",
    });
  }
});

// Get products with low stock.
router.get(
  "/low-stock",
  authenticateToken,
  authorizeRoles("inventory_manager", "admin"),
  async (req, res) => {
    try {
      const products = await getLowStockProducts();

      return res.status(200).json({
        count: products.length,
        products,
      });
    } catch (error) {
      console.error("Failed to fetch low-stock products:", error);

      return res.status(500).json({
        message: "Failed to fetch low-stock products",
      });
    }
  },
);

// Get inventory for a product.
router.get("/:productId", authenticateToken, async (req, res) => {
  const productId = Number(req.params.productId);

  if (!Number.isSafeInteger(productId) || productId <= 0) {
    return res.status(400).json({
      message: "Product ID must be a positive integer",
    });
  }

  try {
    const inventory = await getInventoryByProductId(productId);

    if (!inventory) {
      return res.status(404).json({
        message: "Inventory not found",
      });
    }

    return res.status(200).json({ inventory });
  } catch (error) {
    return res.status(500).json({
      message: "Failed to retrieve inventory",
    });
  }
});

// Decrease stock.
router.patch(
  "/:productId/decrease",
  authenticateToken,
  authorizeRoles("inventory_manager", "admin"),
  async (req, res) => {
    const productId = Number(req.params.productId);
    const { quantity } = req.body;

    if (!Number.isSafeInteger(productId) || productId <= 0) {
      return res.status(400).json({
        message: "Product ID must be a positive integer",
      });
    }

    if (
      !Number.isSafeInteger(quantity) ||
      quantity <= 0 ||
      quantity > 2147483647
    ) {
      return res.status(400).json({
        message: "Quantity must be a positive integer within the allowed limit",
      });
    }

    try {
      const inventory = await decreaseStock(productId, quantity, req.user.id);

      return res.status(200).json({
        message: "Stock decreased successfully",
        inventory,
      });
    } catch (error) {
      return res.status(error.statusCode || 500).json({
        message: error.statusCode ? error.message : "Failed to decrease stock",
      });
    }
  },
);

// Increase stock.
router.patch(
  "/:productId/increase",
  authenticateToken,
  authorizeRoles("inventory_manager", "admin"),
  async (req, res) => {
    const productId = Number(req.params.productId);
    const { quantity } = req.body;

    if (!Number.isSafeInteger(productId) || productId <= 0) {
      return res.status(400).json({
        message: "Product ID must be a positive integer",
      });
    }

    if (
      !Number.isSafeInteger(quantity) ||
      quantity <= 0 ||
      quantity > 2147483647
    ) {
      return res.status(400).json({
        message: "Quantity must be a positive integer within the allowed limit",
      });
    }

    try {
      const inventory = await increaseStock(productId, quantity, req.user.id);

      return res.status(200).json({
        message: "Stock increased successfully",
        inventory,
      });
    } catch (error) {
      return res.status(error.statusCode || 500).json({
        message: error.statusCode ? error.message : "Failed to increase stock",
      });
    }
  },
);

module.exports = router;
