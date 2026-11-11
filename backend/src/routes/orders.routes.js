const express = require("express");

const authenticateToken = require("../middleware/auth.middleware");
const authorizeRoles = require("../middleware/authorize-roles");
const orderService = require("../services/order.service");

const router = express.Router();

// Create an order.
// Only customers and admins can place orders.
router.post(
  "/",
  authenticateToken,
  authorizeRoles("customer", "admin"),
  async (req, res) => {
    try {
      const items = req.body?.items;

      const order = await orderService.createOrder(req.user.id, items);

      return res.status(201).json({
        message: "Order created successfully",
        order,
      });
    } catch (error) {
      if ([400, 404, 409].includes(error.statusCode)) {
        return res.status(error.statusCode).json({
          message: error.message,
        });
      }

      console.error("Failed to create order:", error);

      return res.status(500).json({
        message: "Failed to create order",
      });
    }
  },
);

// Get the authenticated user's order history.
// Supports pagination using page and limit.
router.get("/", authenticateToken, async (req, res) => {
  try {
    const page = req.query.page === undefined ? 1 : Number(req.query.page);
    const limit = req.query.limit === undefined ? 10 : Number(req.query.limit);

    const result = await orderService.getUserOrders(req.user.id, {
      page,
      limit,
    });

    return res.status(200).json(result);
  } catch (error) {
    if ([400, 404].includes(error.statusCode)) {
      return res.status(error.statusCode).json({
        message: error.message,
      });
    }

    console.error("Failed to fetch orders:", error);

    return res.status(500).json({
      message: "Failed to retrieve orders",
    });
  }
});

// Get a specific order.
// Users can only retrieve their own orders.
router.get("/:orderId", authenticateToken, async (req, res) => {
  try {
    const order = await orderService.getOrderById(
      req.user.id,
      req.params.orderId,
    );

    return res.status(200).json({ order });
  } catch (error) {
    if ([400, 404].includes(error.statusCode)) {
      return res.status(error.statusCode).json({
        message: error.message,
      });
    }

    console.error("Failed to fetch order:", error);

    return res.status(500).json({
      message: "Failed to retrieve order",
    });
  }
});

module.exports = router;
