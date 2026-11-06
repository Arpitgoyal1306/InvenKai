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
      createSupplier({ name: "" , email: "test@example.com" }),
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
      createSupplier({ name: "A".repeat(201), email: "test@example.com" }),
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
      { statusCode: 400 },
    );

    await assert.rejects(
      createSupplier({
        name: "ABC Suppliers",
        email: "a".repeat(250) + "@example.com",
      }),
      { statusCode: 400 },
    );

    await assert.rejects(
      createSupplier({
        name: "ABC Suppliers",
        email: 12345,
        phone: "+919876543210",
      }),
      { statusCode: 400 },
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
      { statusCode: 400 },
    );

    await assert.rejects(
      createSupplier({
        name: "ABC Suppliers",
        phone: "abc1234567",
        email: "test@example.com",
      }),
      { statusCode: 400 },
    );

    await assert.rejects(
      createSupplier({
        name: "ABC Suppliers",
        phone: "1".repeat(31),
        email: "test@example.com",
      }),
      { statusCode: 400 },
    );

    await assert.rejects(
      createSupplier({
        name: "ABC Suppliers",
        phone: 9876543210,
        email: "test@example.com",
      }),
      { statusCode: 400 },
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
      },
    );

    await assert.rejects(
      createSupplier({
        name: "ABC Suppliers",
        email: "   ",
        phone: "   ",
      }),
      { statusCode: 400 },
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
      /Database connection failed/,
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
      /WHERE id = \$1/,
    );

    assert.match(
      queryMock.mock.calls[0].arguments[0],
      /is_active = TRUE/,
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


test("updateSupplier updates a supplier successfully", async () => {
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

  const queryMock = mock.method(
    pool,
    "query",
    async (sql) => {
      if (/SELECT/i.test(sql)) {
        return { rows: [existingSupplier] };
      }

      if (/UPDATE suppliers/i.test(sql)) {
        return { rows: [updatedSupplier] };
      }

      throw new Error("Unexpected database query");
    }
  );

  try {
    const result = await updateSupplier(1, {
      phone: "+91 9999999999",
    });

    assert.deepEqual(result, updatedSupplier);

    // Exactly two database queries should execute.
    assert.equal(queryMock.mock.calls.length, 2);

    // First query fetches the existing supplier.
    assert.match(queryMock.mock.calls[0].arguments[0], /SELECT/i);

    // Second query updates the supplier.
    assert.match(
      queryMock.mock.calls[1].arguments[0],
      /UPDATE suppliers/i
    );

    // Verify unchanged fields are preserved.
    assert.equal(result.name, "ABC Suppliers");
    assert.equal(result.email, "sales@abc.com");
    assert.equal(result.phone, "+91 9999999999");
  } finally {
    queryMock.mock.restore();
  }
});


test("updateSupplier rejects empty update requests", async () => {
  const queryMock = mock.method(pool, "query", async () => {
    throw new Error("Database should not be queried");
  });

  try {
    await assert.rejects(
      updateSupplier(1, {}),
      { statusCode: 400 }
    );

    assert.equal(queryMock.mock.calls.length, 0);
  } finally {
    queryMock.mock.restore();
  }
});

test("updateSupplier rejects invalid fields", async () => {
  const queryMock = mock.method(pool, "query", async () => {
    throw new Error("Database should not be queried");
  });

  try {
    await assert.rejects(
      updateSupplier(1, {
        website: "https://example.com",
      }),
      { statusCode: 400 }
    );

    assert.equal(queryMock.mock.calls.length, 0);
  } finally {
    queryMock.mock.restore();
  }
});

test("updateSupplier rejects invalid supplier IDs", async () => {
  const queryMock = mock.method(pool, "query", async () => {
    throw new Error("Database should not be queried");
  });

  try {
    await assert.rejects(updateSupplier(0, { name: "New Name" }), {
      statusCode: 400,
    });

    await assert.rejects(updateSupplier(-1, { name: "New Name" }), {
      statusCode: 400,
    });

    await assert.rejects(updateSupplier(1.5, { name: "New Name" }), {
      statusCode: 400,
    });

    await assert.rejects(updateSupplier("1", { name: "New Name" }), {
      statusCode: 400,
    });

    assert.equal(queryMock.mock.calls.length, 0);
  } finally {
    queryMock.mock.restore();
  }
});

test("updateSupplier returns null when supplier is not found", async () => {
  const queryMock = mock.method(pool, "query", async () => ({
    rows: [],
  }));

  try {
    const result = await updateSupplier(999, {
      phone: "+91 9999999999",
    });

    assert.equal(result, null);

    // Only SELECT should execute. UPDATE should not execute.
    assert.equal(queryMock.mock.calls.length, 1);

    assert.match(
      queryMock.mock.calls[0].arguments[0],
      /SELECT/i
    );
  } finally {
    queryMock.mock.restore();
  }
});

test("updateSupplier rejects invalid updated supplier data", async () => {
  const existingSupplier = {
    id: 1,
    name: "ABC Suppliers",
    contact_name: "Rahul",
    email: "sales@abc.com",
    phone: "+91 9876543210",
    is_active: true,
  };

  const queryMock = mock.method(
    pool,
    "query",
    async () => ({
      rows: [existingSupplier],
    })
  );

  try {
    // Invalid supplier name
    await assert.rejects(
      updateSupplier(1, { name: "   " }),
      { statusCode: 400 }
    );

    // Invalid email
    await assert.rejects(
      updateSupplier(1, { email: "invalid-email" }),
      { statusCode: 400 }
    );

    // Invalid phone
    await assert.rejects(
      updateSupplier(1, { phone: "12345" }),
      { statusCode: 400 }
    );

    // Removing the only available contact method
    await assert.rejects(
      updateSupplier(1, {
        email: null,
        phone: null,
      }),
      { statusCode: 400 }
    );

    // Only SELECT queries should execute; no UPDATE.
    assert.equal(queryMock.mock.calls.length, 4);
  } finally {
    queryMock.mock.restore();
  }
});

test("updateSupplier propagates database errors", async () => {
  const queryMock = mock.method(pool, "query", async () => {
    throw new Error("Database connection failed");
  });

  try {
    await assert.rejects(
      updateSupplier(1, {
        phone: "+91 9999999999",
      }),
      /Database connection failed/
    );

    assert.equal(queryMock.mock.calls.length, 1);
  } finally {
    queryMock.mock.restore();
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