const app = require("./src/app");
const pool = require("./src/config/database");

const PORT = process.env.PORT || 5001;

async function startServer() {
  try {
    await pool.query("SELECT NOW()");

    console.log("PostgreSQL connected successfully");

    app.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });
  } catch (error) {
    console.error("Database connection failed:", error.message);
    process.exit(1);
  }
}

startServer();
