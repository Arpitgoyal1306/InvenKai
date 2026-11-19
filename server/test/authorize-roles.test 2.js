const test = require("node:test");
const assert = require("node:assert/strict");
const authorizeRoles = require("../src/middleware/authorize-roles");

const createResponse = () => {
  const res = {
    statusCode: null,
    body: null,

    status(code) {
      this.statusCode = code;
      return this;
    },

    json(data) {
      this.body = data;
      return this;
    },
  };

  return res;
};

test("returns 401 when the user is not authenticated", () => {
  const req = {};
  const res = createResponse();
  let nextCalled = false;

  authorizeRoles("admin")(req, res, () => {
    nextCalled = true;
  });

  assert.equal(res.statusCode, 401);
  assert.equal(res.body.message, "Authentication required");
  assert.equal(nextCalled, false);
});

test("returns 403 when the user does not have an allowed role", () => {
  const req = {
    user: {
      id: "1",
      role: "customer",
    },
  };

  const res = createResponse();
  let nextCalled = false;

  authorizeRoles("admin")(req, res, () => {
    nextCalled = true;
  });

  assert.equal(res.statusCode, 403);
  assert.equal(
    res.body.message,
    "You do not have permission to access this resource",
  );
  assert.equal(nextCalled, false);
});

test("allows a user with an authorized role", () => {
  const req = {
    user: {
      id: "2",
      role: "admin",
    },
  };

  const res = createResponse();
  let nextCalled = false;

  authorizeRoles("admin")(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, null);
});

test("allows any one of multiple authorized roles", () => {
  const req = {
    user: {
      id: "3",
      role: "inventory_manager",
    },
  };

  const res = createResponse();
  let nextCalled = false;

  authorizeRoles("admin", "inventory_manager")(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true);
});
