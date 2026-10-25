const express = require("express");
const {
  register,
  login,
} = require("../controllers/auth.controller");
const authenticateToken = require("../middleware/auth.middleware");

const router = express.Router();

router.post("/register", register);
router.post("/login", login);

router.get("/me", authenticateToken, (req, res) => {
  res.status(200).json({
    user: req.user,
  });
});

module.exports = router;