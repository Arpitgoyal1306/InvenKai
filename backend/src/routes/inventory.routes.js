const express = require("express");
const authenticateToken = require("../middleware/auth.middleware");
const authorizeRoles = require("../middleware/authorize-roles");
const {
  getInventoryByProductId,
  decreaseStock,
} = require("../services/inventory.service");

const router = express.Router();

// Get inventory for a product.
// Any authenticated user can view inventory.
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
// Only inventory managers and admins can perform this action.
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

    if (!Number.isSafeInteger(quantity) || quantity <= 0) {
      return res.status(400).json({
        message: "Quantity must be a positive integer",
      });
    }

    try {
      const inventory = await decreaseStock(productId, quantity);

      return res.status(200).json({
        message: "Stock decreased successfully",
        inventory,
      });
    } catch (error) {
      if (
        error.message === "Product inventory not found or insufficient stock"
      ) {
        return res.status(409).json({
          message: error.message,
        });
      }

      return res.status(500).json({
        message: "Failed to decrease stock",
      });
    }
  },
);

module.exports = router;
