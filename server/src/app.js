const { STATUS_CODES } = require("node:http");
const { existsSync } = require("node:fs");
const path = require("node:path");
const { isIP } = require("node:net");
const cors = require("cors");
const express = require("express");
const pool = require("./config/database");

const authRoutes = require("./routes/auth.routes");
const inventoryRoutes = require("./routes/inventory.routes");
const supplierRoutes = require("./routes/supplier.routes");
const reportsRoutes = require("./routes/reports.routes");
const productRoutes = require("./routes/product.routes");
const ordersRoutes = require("./routes/orders.routes");

const app = express();

if (process.env.TRUSTED_PROXY_IPS?.trim()) {
  const addresses = process.env.TRUSTED_PROXY_IPS.split(",").map(value => value.trim());
  if (addresses.some(address => !isIP(address))) {
    throw new Error("TRUSTED_PROXY_IPS must contain comma-separated proxy IP addresses");
  }
  app.set("trust proxy", addresses);
}

const allowedOrigins = process.env.CLIENT_URL ? [new URL(process.env.CLIENT_URL).origin] : [];
app.use(cors({ origin: allowedOrigins, credentials: true }));
app.use("/api/market", express.json({limit:"600kb"}), require("./routes/market.routes"));
app.use(express.json());

// API routes
app.use("/api/auth", authRoutes);
app.use("/api/inventory", inventoryRoutes);
app.use("/api/suppliers", supplierRoutes);
app.use("/api/reports", reportsRoutes);
app.use("/api/products", productRoutes);
app.use("/api/orders", ordersRoutes);
app.use("/api", require("./routes/workspace.routes"));

const clientDirectory = path.resolve(__dirname, "../../client/dist");
const clientIndex = path.join(clientDirectory, "index.html");

if (process.env.NODE_ENV === "production" && existsSync(clientIndex)) {
  app.use(express.static(clientDirectory, { index: false }));
  // Serve deep links for the browser while keeping API and missing asset errors as JSON.
  app.get(/.*/, (req, res, next) => {
    if (/^\/(?:api|health|ws)(?:\/|$)/.test(req.path) || path.extname(req.path) ||
        !req.get("accept")?.includes("text/html")) return next();
    res.set("Cache-Control", "no-cache").sendFile(clientIndex);
  });
}

app.get("/", (req, res) => {
  res.json({
    message: "InvenKai API is running",
  });
});

app.get("/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");

    res.json({
      status: "ok",
      database: "connected",
    });
  } catch (error) {
    res.status(503).json({
      status: "error",
      database: "disconnected",
    });
  }
});

// Handle unknown routes
app.use((req, res) => {
  res.status(404).json({
    message: "Route not found",
  });
});

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);

  const code = err.statusCode ?? err.status;
  const status = Number.isInteger(code) && code >= 400 && code <= 599 ? code : 500;
  if (status >= 500) console.error("Unhandled request error:", err.message);

  const message = err.type === "entity.parse.failed"
    ? "Invalid JSON request body"
    : STATUS_CODES[status] || "Request failed";
  return res.status(status).json({ message });
});

module.exports = app;
