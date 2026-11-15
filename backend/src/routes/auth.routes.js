const express = require("express");
const { register, login } = require("../controllers/auth.controller");
const {
  createWebSocketTicket,
} = require("../controllers/websocket-ticket.controller");
const authenticateToken = require("../middleware/auth.middleware");
const authorizeRoles = require("../middleware/authorize-roles");

const router = express.Router();

router.post("/register", register);
router.post("/login", login);

router.post(
  "/ws-ticket",
  authenticateToken,
  authorizeRoles("admin", "inventory_manager"),
  createWebSocketTicket,
);

router.get("/me", authenticateToken, (req, res) => {
  res.status(200).json({
    user: req.user,
  });
});

module.exports = router;
