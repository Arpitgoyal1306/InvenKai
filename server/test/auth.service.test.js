const { test, mock } = require("node:test");
const assert = require("node:assert/strict");

const pool = require("../src/config/database");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { registerUser, loginUser } = require("../src/services/auth.service");

// Registration tests

test("registerUser creates a user with a hashed password", async (t) => {
  const query = mock.method(pool, "query", async (_sql, params) => ({
    rows: [
      {
        id: "1",
        name: params[0],
        email: params[1],
        role: "customer",
        created_at: new Date(),
      },
    ],
    rowCount: 1,
  }));

  t.after(() => mock.restoreAll());

  const user = await registerUser({
    name: "Test User",
    email: "TEST@EXAMPLE.COM",
    password: "password123",
  });

  assert.equal(user.name, "Test User");
  assert.equal(user.email, "test@example.com");
  assert.equal(user.role, "customer");
  assert.equal("password_hash" in user, false);

  const passwordHash = query.mock.calls[0].arguments[1][2];
  assert.notEqual(passwordHash, "password123");
  assert.equal(await bcrypt.compare("password123", passwordHash), true);
});

test("registerUser rejects a password shorter than 8 characters", async () => {
  await assert.rejects(
    registerUser({
      name: "Test User",
      email: "test@example.com",
      password: "short",
    }),
    { statusCode: 400 },
  );
});

test("registerUser rejects a missing name", async () => {
  await assert.rejects(
    registerUser({
      name: " ",
      email: "test@example.com",
      password: "password123",
    }),
    { statusCode: 400 },
  );
});

test("registerUser reports duplicate emails", async (t) => {
  const query = mock.method(pool, "query", async () => {
    const error = new Error("Duplicate key");
    error.code = "23505";
    error.constraint = "users_email_key";
    throw error;
  });

  t.after(() => mock.restoreAll());

  await assert.rejects(
    registerUser({
      name: "Test User",
      email: "existing@example.com",
      password: "password123",
    }),
    { statusCode: 409, message: "Email is already registered" },
  );

  assert.equal(query.mock.callCount(), 1);
});

// Login tests

test("loginUser returns a JWT and safe user details for valid credentials", async (t) => {
  const passwordHash = await bcrypt.hash("password123", 4);

  mock.method(pool, "query", async () => ({
    rows: [
      {
        id: "42",
        name: "Test User",
        email: "test@example.com",
        password_hash: passwordHash,
        role: "customer",
      },
    ],
  }));

  t.after(() => mock.restoreAll());

  const result = await loginUser({
    email: " TEST@EXAMPLE.COM ",
    password: "password123",
  });

  assert.equal(typeof result.token, "string");
  assert.equal(result.user.id, "42");
  assert.equal(result.user.email, "test@example.com");
  assert.equal(result.user.name, "Test User");
  assert.equal(result.user.role, "customer");
  assert.equal("password_hash" in result.user, false);

  const decoded = jwt.verify(result.token, process.env.JWT_SECRET);
  assert.equal(decoded.sub, "42");
  assert.equal(decoded.role, "customer");
});

test("loginUser rejects an incorrect password", async (t) => {
  const passwordHash = await bcrypt.hash("correctPassword", 4);

  mock.method(pool, "query", async () => ({
    rows: [
      {
        id: "42",
        name: "Test User",
        email: "test@example.com",
        password_hash: passwordHash,
        role: "customer",
      },
    ],
  }));

  t.after(() => mock.restoreAll());

  await assert.rejects(
    loginUser({
      email: "test@example.com",
      password: "wrongPassword",
    }),
    { statusCode: 401, message: "Invalid email or password" },
  );
});

test("loginUser rejects an unknown email", async (t) => {
  mock.method(pool, "query", async () => ({ rows: [] }));

  t.after(() => mock.restoreAll());

  await assert.rejects(
    loginUser({
      email: "unknown@example.com",
      password: "password123",
    }),
    { statusCode: 401, message: "Invalid email or password" },
  );
});

test("loginUser rejects invalid input", async () => {
  await assert.rejects(
    loginUser({
      email: "not-an-email",
      password: "password123",
    }),
    { statusCode: 400 },
  );
});

test("registerUser and loginUser accept valid emails with leading/trailing whitespace and maximum 254-character length", async (t) => {
  const passwordHash = await bcrypt.hash("password123", 4);
  const maxLengthEmail = `${"a".repeat(242)}@example.com`;
  assert.equal(maxLengthEmail.length, 254);

  const query = mock.method(pool, "query", async (sql, params) => {
    if (sql.includes("INSERT INTO users")) {
      return {
        rows: [
          {
            id: "1",
            name: params[0],
            email: params[1],
            role: "customer",
            created_at: new Date(),
          },
        ],
        rowCount: 1,
      };
    }

    return {
      rows: [
        {
          id: "1",
          name: "Test User",
          email: params[0],
          password_hash: passwordHash,
          role: "customer",
        },
      ],
    };
  });

  t.after(() => mock.restoreAll());

  const registeredSubdomain = await registerUser({
    name: "Test User",
    email: "  USER@MAIL.EXAMPLE.CO.UK  ",
    password: "password123",
  });
  assert.equal(registeredSubdomain.email, "user@mail.example.co.uk");

  const registeredMaxLen = await registerUser({
    name: "Test User",
    email: `  ${maxLengthEmail}  `,
    password: "password123",
  });
  assert.equal(registeredMaxLen.email, maxLengthEmail);

  const loggedInSubdomain = await loginUser({
    email: "  USER@MAIL.EXAMPLE.CO.UK  ",
    password: "password123",
  });
  assert.equal(loggedInSubdomain.user.email, "user@mail.example.co.uk");

  const loggedInMaxLen = await loginUser({
    email: `  ${maxLengthEmail}  `,
    password: "password123",
  });
  assert.equal(loggedInMaxLen.user.email, maxLengthEmail);
  assert.equal(query.mock.callCount(), 4);
});

test("registerUser and loginUser reject missing, empty, whitespace-only, malformed, and >254-character emails", async (t) => {
  const query = mock.method(pool, "query", async () => {
    throw new Error("Database should not be queried for invalid email");
  });

  t.after(() => mock.restoreAll());

  const overMaxLengthEmail = `${"a".repeat(243)}@example.com`;
  assert.equal(overMaxLengthEmail.length, 255);

  const invalidEmails = [
    undefined,
    null,
    "",
    "   ",
    "user@",
    "@example.com",
    "user@example",
    "user@example.",
    "user@.example.com",
    "user@example..com",
    "user@sub..example.com",
    ".user@example.com",
    "user.@example.com",
    "user..name@example.com",
    "user name@example.com",
    "user\vname@example.com",
    "user\fname@example.com",
    "user\tname@example.com",
    "user\nname@example.com",
    "user\rname@example.com",
    "user@extra@example.com",
    overMaxLengthEmail,
  ];

  for (const invalidEmail of invalidEmails) {
    await assert.rejects(
      registerUser({
        name: "Test User",
        email: invalidEmail,
        password: "password123",
      }),
      {
        statusCode: 400,
        message:
          "Name, valid email, and password of at least 8 characters are required",
      },
    );

    await assert.rejects(
      loginUser({
        email: invalidEmail,
        password: "password123",
      }),
      {
        statusCode: 400,
        message: "Valid email and password are required",
      },
    );
  }

  assert.equal(query.mock.callCount(), 0);
});

test("registerUser and loginUser quickly reject very long malicious-looking email input", async (t) => {
  const query = mock.method(pool, "query", async () => {
    throw new Error("Database should not be queried for malicious email input");
  });

  t.after(() => mock.restoreAll());

  const maliciousEmail = `a@${"a.".repeat(50000)} `;

  await assert.rejects(
    registerUser({
      name: "Test User",
      email: maliciousEmail,
      password: "password123",
    }),
    {
      statusCode: 400,
      message:
        "Name, valid email, and password of at least 8 characters are required",
    },
  );

  await assert.rejects(
    loginUser({
      email: maliciousEmail,
      password: "password123",
    }),
    {
      statusCode: 400,
      message: "Valid email and password are required",
    },
  );

  assert.equal(query.mock.callCount(), 0);
});
