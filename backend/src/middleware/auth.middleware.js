const jwt = require("jsonwebtoken");

const authenticateToken = (req, res, next) => {
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

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    if (
      typeof decoded !== "object" ||
      !decoded.sub ||
      typeof decoded.role !== "string"
    ) {
      return res.status(401).json({
        message: "Invalid or expired token",
      });
    }

    req.user = {
      id: decoded.sub,
      role: decoded.role,
    };

    return next();
  } catch (error) {
    return res.status(401).json({
      message: "Invalid or expired token",
    });
  }
};

module.exports = authenticateToken;