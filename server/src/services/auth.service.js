const jwt = require("jsonwebtoken");
const pool = require("../config/database");
const bcrypt = require("bcrypt");
const { validPhone } = require("../utils/contact");

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
  if (!isValidEmail(email) || typeof password !== "string" || !password) {
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

  if (
    !user?.password_hash ||
    !(await bcrypt.compare(password, user.password_hash))
  ) {
    const error = new Error("Invalid email or password");
    error.statusCode = 401;
    throw error;
  }

  return createLoginSession(user);
}

function createLoginSession(user, google = false) {
  if (!process.env.JWT_SECRET) {
    throw new Error("JWT_SECRET is not configured");
  }

  const token = jwt.sign(
    {
      sub: String(user.id),
      role: user.role,
      ...(google && { authProvider: "google" }),
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
      ...(user.avatar_url && { avatar_url: user.avatar_url }),
    },
  };
}

const profileFields =
  "id, name, email, role, phone, pickup_address, avatar_url, password_hash IS NULL AS google_only";

function publicProfile({ google_only, avatar_url, ...profile }) {
  return {
    ...profile,
    ...(google_only && { google_only }),
    ...(avatar_url && { avatar_url }),
  };
}

function googleAvatar(picture) {
  if (typeof picture !== "string" || picture.length > 2048) return null;
  try {
    const url = new URL(picture);
    if (
      url.protocol === "https:" &&
      url.hostname.endsWith(".googleusercontent.com") &&
      !url.username &&
      !url.password &&
      !url.port
    )
      return url.href;
  } catch {}
  return null;
}

async function loginWithGoogle({
  sub,
  name,
  email,
  email_verified,
  hd,
  picture,
}) {
  if (
    typeof sub !== "string" ||
    !sub ||
    email_verified !== true ||
    !isValidEmail(email)
  ) {
    throw profileError("Choose a Google account with a verified email.", 400);
  }
  const normalizedEmail = email.trim().toLowerCase();
  const avatar = googleAvatar(picture);
  const existing = await pool.query(
    "UPDATE users SET avatar_url=COALESCE($2,avatar_url) WHERE google_subject=$1 RETURNING id,name,email,role,avatar_url",
    [sub, avatar],
  );
  if (existing.rowCount) return createLoginSession(existing.rows[0], true);
  try {
    const {
      rows: [user],
    } = await pool.query(
      `INSERT INTO users(name,email,google_subject,avatar_url) VALUES($1,$2,$3,$4)
       ON CONFLICT(google_subject) DO UPDATE SET avatar_url=COALESCE(excluded.avatar_url,users.avatar_url)
       RETURNING id,name,email,role,avatar_url`,
      [
        ((typeof name === "string" && name.trim()) || "Google user").slice(
          0,
          100,
        ),
        normalizedEmail,
        sub,
        avatar,
      ],
    );
    return createLoginSession(user, true);
  } catch (error) {
    if (error.code !== "23505" || error.constraint !== "users_email_key")
      throw error;
    const googleOwnsEmail =
      normalizedEmail.endsWith("@gmail.com") ||
      (typeof hd === "string" && Boolean(hd.trim()));
    if (!googleOwnsEmail) {
      throw profileError(
        "Sign in with your InvenKai password. Google cannot confirm ownership of this existing email.",
        409,
      );
    }

    // A legacy password registration does not verify the email. Replace that
    // credential so the Google owner does not inherit a password someone else chose.
    const {
      rows: [linked],
    } = await pool.query(
      `UPDATE users SET google_subject=$2, avatar_url=COALESCE($3,avatar_url),
          password_hash=NULL, updated_at=NOW()
       WHERE email=$1 AND role='customer' AND google_subject IS NULL
       RETURNING id,name,email,role,avatar_url`,
      [normalizedEmail, sub, avatar],
    );
    if (linked) return createLoginSession(linked, true);

    const {
      rows: [alreadyLinked],
    } = await pool.query(
      "SELECT id,name,email,role,avatar_url FROM users WHERE google_subject=$1",
      [sub],
    );
    if (alreadyLinked) return createLoginSession(alreadyLinked, true);
    throw profileError(
      "This account cannot be linked automatically. Sign in with its original method.",
      409,
    );
  }
}
const addressFields = {
  address: 250,
  city: 100,
  region: 100,
  postalCode: 20,
  country: 100,
};

function profileError(message, status) {
  return Object.assign(new Error(message), { statusCode: status });
}

async function getProfile(id) {
  const {
    rows: [profile],
  } = await pool.query(`SELECT ${profileFields} FROM users WHERE id=$1`, [id]);
  if (!profile) throw profileError("Account no longer exists.", 401);
  return publicProfile(profile);
}

async function updateProfile(id, input) {
  const {
    name,
    email,
    phone = "",
    pickup_address = {},
    currentPassword,
  } = input;
  if (typeof name !== "string" || !name.trim() || name.trim().length > 100)
    throw profileError("Enter a name between 1 and 100 characters.", 400);
  if (!isValidEmail(email))
    throw profileError("Enter a valid email address.", 400);
  if (
    typeof phone !== "string" ||
    (phone.trim() && !validPhone(phone.trim()))
  ) {
    throw profileError("Enter a valid phone number.", 400);
  }
  if (
    !pickup_address ||
    typeof pickup_address !== "object" ||
    Array.isArray(pickup_address)
  )
    throw profileError("Enter a valid address.", 400);
  const address = {};
  for (const [field, max] of Object.entries(addressFields)) {
    const value = pickup_address[field] ?? "";
    if (typeof value !== "string" || value.trim().length > max)
      throw profileError("Check the length of your address fields.", 400);
    if (value.trim()) address[field] = value.trim();
  }

  const normalizedEmail = email.trim().toLowerCase();
  const {
    rows: [current],
  } = await pool.query("SELECT email, password_hash FROM users WHERE id=$1", [
    id,
  ]);
  if (!current) throw profileError("Account no longer exists.", 401);
  if (
    current.email !== normalizedEmail &&
    (!current.password_hash ||
      typeof currentPassword !== "string" ||
      !currentPassword ||
      !(await bcrypt.compare(currentPassword, current.password_hash)))
  ) {
    throw profileError(
      "Enter your current password to change your email address.",
      403,
    );
  }

  try {
    const {
      rows: [profile],
    } = await pool.query(
      `UPDATE users SET name=$2,email=$3,phone=$4,pickup_address=$5,updated_at=NOW()
       WHERE id=$1 AND email=$6 AND password_hash IS NOT DISTINCT FROM $7 RETURNING ${profileFields}`,
      [
        id,
        name.trim(),
        normalizedEmail,
        phone.trim() || null,
        Object.keys(address).length ? address : null,
        current.email,
        current.password_hash,
      ],
    );
    if (!profile)
      throw profileError(
        "Your account changed while saving. Reload and try again.",
        409,
      );
    return publicProfile(profile);
  } catch (error) {
    if (error.code === "23505" && error.constraint === "users_email_key")
      throw profileError("Email is already registered.", 409);
    throw error;
  }
}

module.exports = {
  registerUser,
  loginUser,
  loginWithGoogle,
  getProfile,
  updateProfile,
};
