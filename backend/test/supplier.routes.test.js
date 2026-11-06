
const { test, mock } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const jwt = require("jsonwebtoken");

const pool = require("../src/config/database");
const app = require("../src/app");

function createToken(role) {
  return jwt.sign(
    {
      sub: "1",
      role,
    },
    process.env.JWT_SECRET,
    { expiresIn: "1h" }
  );
}

// GET suppliers requires authentication.
test("GET suppliers rejects requests without a token", async () => {
  const response = await request(app).get("/api/suppliers");

  assert.equal(response.status, 401);
});

// POST suppliers requires authentication.
test("POST suppliers rejects requests without a token", async () => {
  const response = await request(app)
    .post("/api/suppliers")
    .send({
      name: "ABC Suppliers",
      email: "sales@abc.com",
    });

  assert.equal(response.status, 401);
});

// Customers cannot create suppliers.
test("POST suppliers rejects customers", async () => {
  const token = createToken("customer");

  const response = await request(app)
    .post("/api/suppliers")
    .set("Authorization", `Bearer ${token}`)
    .send({
      name: "ABC Suppliers",
      email: "sales@abc.com",
    });

  assert.equal(response.status, 403);
});

// Customers cannot update suppliers.
test("PATCH suppliers rejects customers", async () => {
  const token = createToken("customer");

  const response = await request(app)
    .patch("/api/suppliers/1")
    .set("Authorization", `Bearer ${token}`)
    .send({
      name: "Updated Suppliers",
    });

  assert.equal(response.status, 403);
});

// Only admins can delete suppliers.
test("DELETE suppliers rejects inventory managers", async () => {
  const token = createToken("inventory_manager");

  const response = await request(app)
    .delete("/api/suppliers/1")
    .set("Authorization", `Bearer ${token}`);

  assert.equal(response.status, 403);
});

// DELETE suppliers requires authentication.
test("DELETE suppliers rejects requests without a token", async () => {
  const response = await request(app).delete("/api/suppliers/1");

  assert.equal(response.status, 401);
});


test("POST suppliers creates a supplier successfully for inventory manager", async () => {
  const token = createToken("inventory_manager");

  const mockSupplier = {
    id: 1,
    name: "ABC Suppliers",
    contact_name: "Rahul",
    email: "sales@abc.com",
    phone: "+91 9876543210",
    is_active: true,
  };

  const queryMock = mock.method(pool, "query", async () => ({
    rows: [mockSupplier],
  }));

  try {
    const response = await request(app)
      .post("/api/suppliers")
      .set("Authorization", `Bearer ${token}`)
      .send({
        name: "ABC Suppliers",
        contact_name: "Rahul",
        email: "sales@abc.com",
        phone: "+91 9876543210",
      });

    assert.equal(response.status, 201);
    assert.equal(response.body.message, "Supplier created successfully");
    assert.deepEqual(response.body.supplier, mockSupplier);
    assert.equal(queryMock.mock.calls.length, 1);
  } finally {
    queryMock.mock.restore();
  }
});

test("POST suppliers rejects invalid supplier data", async () => {
  const token = createToken("inventory_manager");

  const response = await request(app)
    .post("/api/suppliers")
    .set("Authorization", `Bearer ${token}`)
    .send({
      name: "   ",
      email: "sales@abc.com",
    });

  assert.equal(response.status, 400);
});


test("GET suppliers returns suppliers with pagination", async () => {
  const token = createToken("customer");

  const mockSuppliers = [
    {
      id: 1,
      name: "ABC Suppliers",
      email: "sales@abc.com",
      is_active: true,
    },
    {
      id: 2,
      name: "XYZ Suppliers",
      phone: "+91 9876543210",
      is_active: true,
    },
  ];

  const queryMock = mock.method(pool, "query", async () => ({
    rows: mockSuppliers,
  }));

  try {
    const response = await request(app)
      .get("/api/suppliers?limit=10&offset=0")
      .set("Authorization", `Bearer ${token}`);

    assert.equal(response.status, 200);
    assert.deepEqual(response.body.suppliers, mockSuppliers);
    assert.deepEqual(response.body.pagination, {
      limit: 10,
      offset: 0,
    });
    assert.equal(queryMock.mock.calls.length, 1);
  } finally {
    queryMock.mock.restore();
  }
});

test("GET supplier by ID returns a supplier successfully", async () => {
  const token = createToken("customer");

  const mockSupplier = {
    id: 1,
    name: "ABC Suppliers",
    email: "sales@abc.com",
    is_active: true,
  };

  const queryMock = mock.method(pool, "query", async () => ({
    rows: [mockSupplier],
  }));

  try {
    const response = await request(app)
      .get("/api/suppliers/1")
      .set("Authorization", `Bearer ${token}`);

    assert.equal(response.status, 200);
    assert.deepEqual(response.body.supplier, mockSupplier);
    assert.equal(queryMock.mock.calls.length, 1);
  } finally {
    queryMock.mock.restore();
  }
});



test("GET suppliers rejects invalid pagination parameters", async () => {
  const token = createToken("customer");

  for (const query of [
    "?limit=0",
    "?limit=-5",
    "?offset=-1",
    "?limit=1.5",
    "?limit=101",
  ]) {
    const response = await request(app)
      .get(`/api/suppliers${query}`)
      .set("Authorization", `Bearer ${token}`);

    assert.equal(response.status, 400);
  }
});

test("GET supplier by ID rejects invalid IDs", async () => {
  const token = createToken("customer");

  for (const id of ["abc", "0", "-1", "1.5"]) {
    const response = await request(app)
      .get(`/api/suppliers/${id}`)
      .set("Authorization", `Bearer ${token}`);

    assert.equal(response.status, 400);
  }
});

test("GET supplier by ID returns 404 when supplier does not exist", async () => {
  const token = createToken("customer");

  const queryMock = mock.method(pool, "query", async () => ({
    rows: [],
  }));

  try {
    const response = await request(app)
      .get("/api/suppliers/999")
      .set("Authorization", `Bearer ${token}`);

    assert.equal(response.status, 404);
    assert.equal(response.body.message, "Supplier not found");
  } finally {
    queryMock.mock.restore();
  }
});


test("PATCH suppliers updates a supplier for inventory manager", async () => {
  const token = createToken("inventory_manager");

  const updatedSupplier = {
    id: 1,
    name: "ABC Suppliers",
    contact_name: "Rahul",
    email: "sales@abc.com",
    phone: "+91 9999999999",
    is_active: true,
  };

  let queryCount = 0;

  const queryMock = mock.method(pool, "query", async (sql) => {
    queryCount++;

    if (/SELECT/i.test(sql)) {
      return {
        rows: [{
          ...updatedSupplier,
          phone: "+91 9876543210",
        }],
      };
    }

    if (/UPDATE suppliers/i.test(sql)) {
      return { rows: [updatedSupplier] };
    }

    throw new Error("Unexpected database query");
  });

  try {
    const response = await request(app)
      .patch("/api/suppliers/1")
      .set("Authorization", `Bearer ${token}`)
      .send({
        phone: "+91 9999999999",
      });

    assert.equal(response.status, 200);
    assert.equal(response.body.message, "Supplier updated successfully");
    assert.deepEqual(response.body.supplier, updatedSupplier);
    assert.equal(queryCount, 2);
  } finally {
    queryMock.mock.restore();
  }
});

test("PATCH suppliers updates a supplier for admin", async () => {
  const token = createToken("admin");

  const updatedSupplier = {
    id: 1,
    name: "Updated Suppliers",
    email: "sales@abc.com",
    is_active: true,
  };

  const queryMock = mock.method(pool, "query", async (sql) => {
    if (/SELECT/i.test(sql)) {
      return {
        rows: [{
          id: 1,
          name: "ABC Suppliers",
          email: "sales@abc.com",
          phone: null,
          contact_name: null,
          is_active: true,
        }],
      };
    }

    return { rows: [updatedSupplier] };
  });

  try {
    const response = await request(app)
      .patch("/api/suppliers/1")
      .set("Authorization", `Bearer ${token}`)
      .send({
        name: "Updated Suppliers",
      });

    assert.equal(response.status, 200);
    assert.equal(response.body.supplier.name, "Updated Suppliers");
    assert.equal(queryMock.mock.calls.length, 2);
  } finally {
    queryMock.mock.restore();
  }
});


test("PATCH suppliers rejects invalid supplier IDs", async () => {
  const token = createToken("inventory_manager");

  for (const id of ["abc", "0", "-1", "1.5"]) {
    const response = await request(app)
      .patch(`/api/suppliers/${id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Updated Suppliers" });

    assert.equal(response.status, 400);
  }
});

test("PATCH suppliers rejects empty update requests", async () => {
  const token = createToken("inventory_manager");

  const response = await request(app)
    .patch("/api/suppliers/1")
    .set("Authorization", `Bearer ${token}`)
    .send({});

  assert.equal(response.status, 400);
});

test("PATCH suppliers returns 404 when supplier does not exist", async () => {
  const token = createToken("inventory_manager");

  const queryMock = mock.method(pool, "query", async () => ({
    rows: [],
  }));

  try {
    const response = await request(app)
      .patch("/api/suppliers/999")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Updated Suppliers" });

    assert.equal(response.status, 404);
    assert.equal(response.body.message, "Supplier not found");
    assert.equal(queryMock.mock.calls.length, 1);
  } finally {
    queryMock.mock.restore();
  }
});



test("DELETE suppliers soft deletes a supplier for admin", async () => {
  const token = createToken("admin");

  const deletedSupplier = {
    id: 1,
    name: "ABC Suppliers",
    email: "sales@abc.com",
    phone: "+91 9876543210",
    is_active: false,
  };

  const queryMock = mock.method(pool, "query", async () => ({
    rows: [deletedSupplier],
  }));

  try {
    const response = await request(app)
      .delete("/api/suppliers/1")
      .set("Authorization", `Bearer ${token}`);

    assert.equal(response.status, 200);
    assert.equal(response.body.message, "Supplier deleted successfully");
    assert.equal(response.body.supplier.is_active, false);

    assert.match(
      queryMock.mock.calls[0].arguments[0],
      /is_active = FALSE/i
    );

    assert.equal(queryMock.mock.calls.length, 1);
  } finally {
    queryMock.mock.restore();
  }
});

test("DELETE suppliers rejects invalid supplier IDs", async () => {
  const token = createToken("admin");

  for (const id of ["abc", "0", "-1", "1.5"]) {
    const response = await request(app)
      .delete(`/api/suppliers/${id}`)
      .set("Authorization", `Bearer ${token}`);

    assert.equal(response.status, 400);
  }
});

test("DELETE suppliers returns 404 when supplier does not exist", async () => {
  const token = createToken("admin");

  const queryMock = mock.method(pool, "query", async () => ({
    rows: [],
  }));

  try {
    const response = await request(app)
      .delete("/api/suppliers/999")
      .set("Authorization", `Bearer ${token}`);

    assert.equal(response.status, 404);
    assert.equal(response.body.message, "Supplier not found");
  } finally {
    queryMock.mock.restore();
  }
});
