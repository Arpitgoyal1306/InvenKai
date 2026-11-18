const jwt = require("jsonwebtoken");
const pool = require("../config/database");
const bcrypt = require("bcrypt");

const MAX_EMAIL_LENGTH = 254;

function isValidEmail(email) {
  if (typeof email !== "string") {
    return false;
  }

  const normalizedEmail = email.trim();

  if (!normalizedEmail || normalizedEmail.length > MAX_EMAIL_LENGTH) {
    return false;
  }

  for (let i = 0; i < normalizedEmail.length; i++) {
    const char = normalizedEmail[i];
    if (char.trim() === "") {
      return false;
    }
  }

  const parts = normalizedEmail.split("@");

  if (parts.length !== 2) {
    return false;
  }

  const localPart = parts[0];
  const domain = parts[1];

  if (!localPart || !domain) {
    return false;
  }

  if (
    localPart.startsWith(".") ||
    localPart.endsWith(".") ||
    localPart.includes("..")
  ) {
    return false;
  }

  if (
    !domain.includes(".") ||
    domain.startsWith(".") ||
    domain.endsWith(".") ||
    domain.includes("..")
  ) {
    return false;
  }

  return true;
}

async function registerUser({ name, email, password }) {
  if (
    typeof name !== "string" ||
    !name.trim() ||
    !isValidEmail(email) ||
    typeof password !== "string" ||
    password.length < 8
  ) {
    const error = new Error(
      "Name, valid email, and password of at least 8 characters are required",
    );
    error.statusCode = 400;
    throw error;
  }

  const normalizedEmail = email.trim().toLowerCase();
  const passwordHash = await bcrypt.hash(password, 12);

  try {
    const result = await pool.query(
      `INSERT INTO users (name, email, password_hash)
       VALUES ($1, $2, $3)
       RETURNING id, name, email, role, created_at`,
      [name.trim(), normalizedEmail, passwordHash],
    );

    return result.rows[0];
  } catch (error) {
    if (error.code === "23505" && error.constraint === "users_email_key") {
      const duplicateError = new Error("Email is already registered");
      duplicateError.statusCode = 409;
      throw duplicateError;
    }

    throw error;
  }
}

async function loginUser({ email, password }) {
  if (
    !isValidEmail(email) ||
    typeof password !== "string" ||
    !password
  ) {
    const error = new Error("Valid email and password are required");
    error.statusCode = 400;
    throw error;
  }

  const normalizedEmail = email.trim().toLowerCase();

  const result = await pool.query(
    `SELECT id, name, email, password_hash, role
     FROM users
     WHERE email = $1`,
    [normalizedEmail],
  );

  const user = result.rows[0];

  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    const error = new Error("Invalid email or password");
    error.statusCode = 401;
    throw error;
  }

  if (!process.env.JWT_SECRET) {
    throw new Error("JWT_SECRET is not configured");
  }

  const token = jwt.sign(
    {
      sub: String(user.id),
      role: user.role,
    },
    process.env.JWT_SECRET,
    { expiresIn: "1h" },
  );

  return {
    token,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
    },
  };
}

module.exports = { registerUser, loginUser };
