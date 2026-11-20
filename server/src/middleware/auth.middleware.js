const jwt = require("jsonwebtoken");
const pool = require("../config/database");

const authenticateToken = async (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({
      message: "Authentication token required",
    });
  }

  const token = authHeader.slice(7);

  if (!token || token.includes(" ")) {
    return res.status(401).json({
      message: "Invalid or expired token",
    });
  }

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ message: "Invalid or expired token" });
  }
  if (typeof decoded !== "object" || !decoded.sub || typeof decoded.role !== "string") {
    return res.status(401).json({ message: "Invalid or expired token" });
  }

  try {
    // Converting a legacy account to Google-only also invalidates old password sessions.
    if (
      decoded.role === "customer" &&
      decoded.authProvider !== "google" &&
      /^[1-9]\d{0,18}$/.test(decoded.sub) &&
      BigInt(decoded.sub) <= 9223372036854775807n
    ) {
      const {
        rows: [account],
      } = await pool.query(
        "SELECT 1 FROM users WHERE id=$1 AND google_subject IS NOT NULL AND password_hash IS NULL",
        [decoded.sub],
      );
      if (account)
        return res
          .status(401)
          .json({ message: "Sign in with Google to continue." });
    }

    req.user = {
      id: decoded.sub,
      role: decoded.role,
    };

    return next();
  } catch (error) {
    return next(error);
  }
};

module.exports = authenticateToken;
