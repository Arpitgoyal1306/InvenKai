const express = require("express");

const authenticateToken = require("../middleware/auth.middleware");
const authorizeRoles = require("../middleware/authorize-roles");

const {
  getStockSummary,
  getLowStockSummary,
  getCategoryStock,
  getStockMovement,
} = require("../services/reports.service");

const router = express.Router();

// All reporting endpoints require authentication
// and an inventory_manager or admin role.
router.use(authenticateToken);
router.use(authorizeRoles("inventory_manager", "admin"));

// GET /api/reports/stock-summary
router.get("/stock-summary", async (req, res, next) => {
  try {
    const summary = await getStockSummary();
    res.status(200).json(summary);
  } catch (error) {
    next(error);
  }
});

// GET /api/reports/low-stock
router.get("/low-stock", async (req, res, next) => {
  try {
    const report = await getLowStockSummary();
    res.status(200).json(report);
  } catch (error) {
    next(error);
  }
});

// GET /api/reports/category-stock
// Optional query parameter: categoryId
router.get("/category-stock", async (req, res, next) => {
  try {
    const { categoryId } = req.query;

    const report = await getCategoryStock(categoryId);

    res.status(200).json(report);
  } catch (error) {
    if (error.statusCode === 400) {
      return res.status(400).json({
        message: error.message,
      });
    }

    next(error);
  }
});

// GET /api/reports/stock-movement?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
router.get("/stock-movement", async (req, res, next) => {
  try {
    const { startDate, endDate } = req.query;

    const report = await getStockMovement(startDate, endDate);

    res.status(200).json(report);
  } catch (error) {
    if (error.statusCode === 400) {
      return res.status(400).json({
        message: error.message,
      });
    }

    next(error);
  }
});

module.exports = router;
