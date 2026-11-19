const { rateLimit } = require("express-rate-limit");
const express = require("express");
const { getProfile, updateProfile } = require("../services/auth.service");
const { register, login } = require("../controllers/auth.controller");
const {
  createWebSocketTicket,
} = require("../controllers/websocket-ticket.controller");
const authenticateToken = require("../middleware/auth.middleware");
const authorizeRoles = require("../middleware/authorize-roles");

const router = express.Router();

router.use("/google", require("./google.routes"));
router.post("/register", register);
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  skipSuccessfulRequests: true,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { message: "Too many login attempts. Try again later." },
});

router.post("/login", loginLimiter, login);

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

const profileLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  skipSuccessfulRequests: true,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { message: "Too many failed updates. Try again later." },
});

router.get("/profile", authenticateToken, async (req, res) => {
  res
    .set("Cache-Control", "no-store")
    .json({ user: await getProfile(req.user.id) });
});
router.patch(
  "/profile",
  authenticateToken,
  profileLimiter,
  async (req, res, next) => {
    try {
      const user = await updateProfile(req.user.id, req.body ?? {});
      res.set("Cache-Control", "no-store").json({ user });
    } catch (error) {
      if ([400, 403, 409].includes(error.statusCode))
        return res.status(error.statusCode).json({ message: error.message });
      next(error);
    }
  },
);

module.exports = router;
