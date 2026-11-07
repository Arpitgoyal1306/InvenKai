const { test, mock } = require("node:test");
const assert = require("node:assert/strict");

const pool = require("../src/config/database");

const {
  createSupplier,
  getSuppliers,
  getSupplierById,
  updateSupplier,
  deleteSupplier,
} = require("../src/services/supplier.service");

test("createSupplier creates a supplier successfully", async () => {
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
    const supplier = await createSupplier({
      name: " ABC Suppliers ",
      contact_name: " Rahul ",
      email: " SALES@ABC.COM ",
      phone: "+91 9876543210",
    });

    assert.deepEqual(supplier, mockSupplier);
    assert.equal(queryMock.mock.calls.length, 1);

    assert.deepEqual(queryMock.mock.calls[0].arguments[1], [
      "ABC Suppliers",
      "Rahul",
      "sales@abc.com",
      "+91 9876543210",
    ]);
  } finally {
    queryMock.mock.restore();
  }
});

test("createSupplier rejects invalid supplier names", async () => {
  const queryMock = mock.method(pool, "query", async () => {
    throw new Error("Database should not be queried");
  });

  try {
    await assert.rejects(
      createSupplier({ name: "", email: "test@example.com" }),
      {
        message: "Supplier name is required and must not exceed 200 characters",
        statusCode: 400,
      }
    );

    await assert.rejects(
      createSupplier({ name: "   ", phone: "+919876543210" }),
      { statusCode: 400 }
    );

    await assert.rejects(
      createSupplier({ name: 123, email: "test@example.com" }),
      { statusCode: 400 }
    );

    await assert.rejects(
      createSupplier({
        name: "A".repeat(201),
        email: "test@example.com",
      }),
      { statusCode: 400 }
    );

    assert.equal(queryMock.mock.calls.length, 0);
  } finally {
    queryMock.mock.restore();
  }
});

test("createSupplier rejects invalid email addresses", async () => {
  const queryMock = mock.method(pool, "query", async () => {
    throw new Error("Database should not be queried");
  });

  try {
    await assert.rejects(
      createSupplier({
        name: "ABC Suppliers",
        email: "invalid-email",
      }),
      { statusCode: 400 }
    );

    await assert.rejects(
      createSupplier({
        name: "ABC Suppliers",
        email: "a".repeat(250) + "@example.com",
      }),
      { statusCode: 400 }
    );

    await assert.rejects(
      createSupplier({
        name: "ABC Suppliers",
        email: 12345,
        phone: "+919876543210",
      }),
      { statusCode: 400 }
    );

    assert.equal(queryMock.mock.calls.length, 0);
  } finally {
    queryMock.mock.restore();
  }
});

test("createSupplier rejects invalid phone numbers", async () => {
  const queryMock = mock.method(pool, "query", async () => {
    throw new Error("Database should not be queried");
  });

  try {
    await assert.rejects(
      createSupplier({
        name: "ABC Suppliers",
        phone: "12345",
        email: "test@example.com",
      }),
      { statusCode: 400 }
    );

    await assert.rejects(
      createSupplier({
        name: "ABC Suppliers",
        phone: "abc1234567",
        email: "test@example.com",
      }),
      { statusCode: 400 }
    );

    await assert.rejects(
      createSupplier({
        name: "ABC Suppliers",
        phone: "1".repeat(31),
        email: "test@example.com",
      }),
      { statusCode: 400 }
    );

    await assert.rejects(
      createSupplier({
        name: "ABC Suppliers",
        phone: 9876543210,
        email: "test@example.com",
      }),
      { statusCode: 400 }
    );

    assert.equal(queryMock.mock.calls.length, 0);
  } finally {
    queryMock.mock.restore();
  }
});

test("createSupplier requires at least one contact method", async () => {
  const queryMock = mock.method(pool, "query", async () => {
    throw new Error("Database should not be queried");
  });

  try {
    await assert.rejects(
      createSupplier({
        name: "ABC Suppliers",
      }),
      {
        message: "At least one of email or phone is required",
        statusCode: 400,
      }
    );

    await assert.rejects(
      createSupplier({
        name: "ABC Suppliers",
        email: "   ",
        phone: "   ",
      }),
      { statusCode: 400 }
    );

    assert.equal(queryMock.mock.calls.length, 0);
  } finally {
    queryMock.mock.restore();
  }
});

test("createSupplier accepts email-only and phone-only suppliers", async () => {
  const queryMock = mock.method(pool, "query", async () => ({
    rows: [{ id: 1, name: "ABC Suppliers" }],
  }));

  try {
    await createSupplier({
      name: "ABC Suppliers",
      email: "sales@abc.com",
    });

    await createSupplier({
      name: "XYZ Suppliers",
      phone: "+91 9876543210",
    });

    assert.equal(queryMock.mock.calls.length, 2);

    assert.deepEqual(queryMock.mock.calls[0].arguments[1], [
      "ABC Suppliers",
      null,
      "sales@abc.com",
      null,
    ]);

    assert.deepEqual(queryMock.mock.calls[1].arguments[1], [
      "XYZ Suppliers",
      null,
      null,
      "+91 9876543210",
    ]);
  } finally {
    queryMock.mock.restore();
  }
});

test("createSupplier propagates database errors", async () => {
  const queryMock = mock.method(pool, "query", async () => {
    throw new Error("Database connection failed");
  });

  try {
    await assert.rejects(
      createSupplier({
        name: "ABC Suppliers",
        email: "sales@abc.com",
      }),
      /Database connection failed/
    );

    assert.equal(queryMock.mock.calls.length, 1);
  } finally {
    queryMock.mock.restore();
  }
});

test("getSuppliers returns active suppliers with pagination", async () => {
  const mockSuppliers = [
    { id: 1, name: "ABC Suppliers", is_active: true },
    { id: 2, name: "XYZ Suppliers", is_active: true },
  ];

  const queryMock = mock.method(pool, "query", async () => ({
    rows: mockSuppliers,
  }));

  try {
    const suppliers = await getSuppliers(10, 20);

    assert.deepEqual(suppliers, mockSuppliers);
    assert.equal(queryMock.mock.calls.length, 1);

    assert.deepEqual(queryMock.mock.calls[0].arguments[1], [10, 20]);

    assert.match(
      queryMock.mock.calls[0].arguments[0],
      /WHERE is_active = TRUE/
    );
  } finally {
    queryMock.mock.restore();
  }
});

test("getSuppliers rejects invalid pagination inputs", async () => {
  const queryMock = mock.method(pool, "query", async () => {
    throw new Error("Database should not be queried");
  });

  try {
    await assert.rejects(getSuppliers(-5, 0), {
      statusCode: 400,
    });

    await assert.rejects(getSuppliers(10, -1), {
      statusCode: 400,
    });

    await assert.rejects(getSuppliers(0, 0), {
      statusCode: 400,
    });

    await assert.rejects(getSuppliers(1.5, 0), {
      statusCode: 400,
    });

    assert.equal(queryMock.mock.calls.length, 0);
  } finally {
    queryMock.mock.restore();
  }
});

test("getSupplierById returns an active supplier when found", async () => {
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
    const supplier = await getSupplierById(1);

    assert.deepEqual(supplier, mockSupplier);
    assert.equal(queryMock.mock.calls.length, 1);

    assert.deepEqual(queryMock.mock.calls[0].arguments[1], [1]);

    assert.match(
      queryMock.mock.calls[0].arguments[0],
      /WHERE id = \$1/
    );

    assert.match(
      queryMock.mock.calls[0].arguments[0],
      /is_active = TRUE/
    );
  } finally {
    queryMock.mock.restore();
  }
});

test("getSupplierById returns null when supplier is not found", async () => {
  const queryMock = mock.method(pool, "query", async () => ({
    rows: [],
  }));

  try {
    const supplier = await getSupplierById(999);

    assert.equal(supplier, null);
    assert.equal(queryMock.mock.calls.length, 1);
  } finally {
    queryMock.mock.restore();
  }
});

test("getSupplierById rejects invalid IDs without querying database", async () => {
  const queryMock = mock.method(pool, "query", async () => {
    throw new Error("Database should not be queried");
  });

  try {
    await assert.rejects(getSupplierById(0), { statusCode: 400 });
    await assert.rejects(getSupplierById(-1), { statusCode: 400 });
    await assert.rejects(getSupplierById(1.5), { statusCode: 400 });
    await assert.rejects(getSupplierById("1"), { statusCode: 400 });

    assert.equal(queryMock.mock.calls.length, 0);
  } finally {
    queryMock.mock.restore();
  }
});

function createSupplierClientMock(queryHandler) {
  const queries = [];
  let released = false;

  const client = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      return queryHandler(sql, params);
    },
    release: () => {
      released = true;
    },
  };

  const connectMock = mock.method(
    pool,
    "connect",
    async () => client
  );

  return {
    client,
    queries,
    connectMock,
    wasReleased: () => released,
  };
}

test("updateSupplier updates a supplier successfully inside a transaction", async () => {
  const existingSupplier = {
    id: 1,
    name: "ABC Suppliers",
    contact_name: "Rahul",
    email: "sales@abc.com",
    phone: "+91 9876543210",
    is_active: true,
  };

  const updatedSupplier = {
    ...existingSupplier,
    phone: "+91 9999999999",
  };

  const clientMock = createSupplierClientMock(async (sql) => {
    if (/SELECT/i.test(sql)) {
      return { rows: [existingSupplier] };
    }

    if (/UPDATE suppliers/i.test(sql)) {
      return { rows: [updatedSupplier] };
    }

    return { rows: [] };
  });

  try {
    const result = await updateSupplier(1, {
      phone: "+91 9999999999",
    });

    assert.deepEqual(result, updatedSupplier);
    assert.equal(clientMock.queries.length, 4);

    assert.match(clientMock.queries[0].sql, /BEGIN/i);
    assert.match(clientMock.queries[1].sql, /SELECT/i);
    assert.match(clientMock.queries[1].sql, /FOR UPDATE/i);
    assert.match(clientMock.queries[2].sql, /UPDATE suppliers/i);
    assert.match(clientMock.queries[3].sql, /COMMIT/i);

    assert.deepEqual(clientMock.queries[2].params, [
      "ABC Suppliers",
      "Rahul",
      "sales@abc.com",
      "+91 9999999999",
      1,
    ]);

    assert.equal(clientMock.wasReleased(), true);
    assert.equal(clientMock.connectMock.mock.calls.length, 1);
  } finally {
    clientMock.connectMock.mock.restore();
  }
});

test("updateSupplier rejects empty update requests without connecting", async () => {
  const connectMock = mock.method(pool, "connect", async () => {
    throw new Error("Database should not be connected");
  });

  try {
    await assert.rejects(
      updateSupplier(1, {}),
      { statusCode: 400 }
    );

    assert.equal(connectMock.mock.calls.length, 0);
  } finally {
    connectMock.mock.restore();
  }
});

test("updateSupplier rejects invalid fields without connecting", async () => {
  const connectMock = mock.method(pool, "connect", async () => {
    throw new Error("Database should not be connected");
  });

  try {
    await assert.rejects(
      updateSupplier(1, {
        website: "https://example.com",
      }),
      { statusCode: 400 }
    );

    assert.equal(connectMock.mock.calls.length, 0);
  } finally {
    connectMock.mock.restore();
  }
});

test("updateSupplier rejects invalid supplier IDs without connecting", async () => {
  const connectMock = mock.method(pool, "connect", async () => {
    throw new Error("Database should not be connected");
  });

  try {
    await assert.rejects(
      updateSupplier(0, { name: "New Name" }),
      { statusCode: 400 }
    );

    await assert.rejects(
      updateSupplier(-1, { name: "New Name" }),
      { statusCode: 400 }
    );

    await assert.rejects(
      updateSupplier(1.5, { name: "New Name" }),
      { statusCode: 400 }
    );

    await assert.rejects(
      updateSupplier("1", { name: "New Name" }),
      { statusCode: 400 }
    );

    assert.equal(connectMock.mock.calls.length, 0);
  } finally {
    connectMock.mock.restore();
  }
});

test("updateSupplier returns null when supplier is not found", async () => {
  const clientMock = createSupplierClientMock(async () => ({
    rows: [],
  }));

  try {
    const result = await updateSupplier(999, {
      phone: "+91 9999999999",
    });

    assert.equal(result, null);
    assert.equal(clientMock.queries.length, 3);

    assert.match(clientMock.queries[0].sql, /BEGIN/i);
    assert.match(clientMock.queries[1].sql, /SELECT/i);
    assert.match(clientMock.queries[1].sql, /FOR UPDATE/i);
    assert.match(clientMock.queries[2].sql, /COMMIT/i);

    assert.equal(clientMock.wasReleased(), true);
  } finally {
    clientMock.connectMock.mock.restore();
  }
});

test("updateSupplier rolls back when updated supplier data is invalid", async () => {
  const existingSupplier = {
    id: 1,
    name: "ABC Suppliers",
    contact_name: "Rahul",
    email: "sales@abc.com",
    phone: "+91 9876543210",
    is_active: true,
  };

  const clientMock = createSupplierClientMock(async (sql) => {
    if (/SELECT/i.test(sql)) {
      return { rows: [existingSupplier] };
    }

    return { rows: [] };
  });

  try {
    // Invalid supplier name
    await assert.rejects(
      updateSupplier(1, { name: "   " }),
      { statusCode: 400 }
    );

    // Invalid email address
    await assert.rejects(
      updateSupplier(1, { email: "invalid-email" }),
      { statusCode: 400 }
    );

    // Invalid phone number
    await assert.rejects(
      updateSupplier(1, { phone: "12345" }),
      { statusCode: 400 }
    );

    // Removing both contact methods must be rejected
    await assert.rejects(
      updateSupplier(1, {
        email: null,
        phone: null,
      }),
      { statusCode: 400 }
    );

    // All four invalid updates must roll back.
    const rollbackQueries = clientMock.queries.filter(({ sql }) =>
      /ROLLBACK/i.test(sql)
    );

    assert.equal(rollbackQueries.length, 4);

    // No invalid update should reach the UPDATE query.
    assert.equal(
      clientMock.queries.some(({ sql }) => /UPDATE suppliers/i.test(sql)),
      false
    );

    assert.equal(clientMock.wasReleased(), true);
  } finally {
    clientMock.connectMock.mock.restore();
  }
});

test("updateSupplier propagates database errors and rolls back", async () => {
  const clientMock = createSupplierClientMock(async (sql) => {
    if (/SELECT/i.test(sql)) {
      throw new Error("Database connection failed");
    }

    return { rows: [] };
  });

  try {
    await assert.rejects(
      updateSupplier(1, {
        phone: "+91 9999999999",
      }),
      /Database connection failed/
    );

    assert.match(
      clientMock.queries.at(-1).sql,
      /ROLLBACK/i
    );

    assert.equal(clientMock.wasReleased(), true);
  } finally {
    clientMock.connectMock.mock.restore();
  }
});

test("deleteSupplier soft deletes a supplier successfully", async () => {
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
    const result = await deleteSupplier(1);

    assert.deepEqual(result, deletedSupplier);
    assert.equal(queryMock.mock.calls.length, 1);

    assert.match(
      queryMock.mock.calls[0].arguments[0],
      /UPDATE suppliers/i
    );

    assert.match(
      queryMock.mock.calls[0].arguments[0],
      /is_active = FALSE/i
    );

    assert.deepEqual(
      queryMock.mock.calls[0].arguments[1],
      [1]
    );
  } finally {
    queryMock.mock.restore();
  }
});

test("createSupplier rejects null or invalid supplier data", async () => {
  const queryMock = mock.method(pool, "query", async () => {
    throw new Error("Database should not be queried");
  });

  try {
    await assert.rejects(createSupplier(null), { statusCode: 400 });
    await assert.rejects(createSupplier([]), { statusCode: 400 });

    assert.equal(queryMock.mock.calls.length, 0);
  } finally {
    queryMock.mock.restore();
  }
});