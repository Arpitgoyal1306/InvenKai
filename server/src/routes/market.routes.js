const router = require("express").Router();
const db = require("../config/database");
const auth = require("../middleware/auth.middleware");
const { createOrder } = require("../services/order.service");
const { validPhone } = require("../utils/contact");
const { randomUUID } = require("node:crypto");

function fail(message, status = 400) {
  throw Object.assign(new Error(message), { marketStatus: status });
}
function text(value, max, required = true) {
  if (
    typeof value !== "string" ||
    value.trim().length > max ||
    (required && !value.trim())
  )
    fail("Check the required fields and their lengths.");
  return value.trim();
}
function slug(value) {
  if (
    typeof value !== "string" ||
    value.length < 3 ||
    value.length > 68 ||
    value
      .split("-")
      .some(
        (part) =>
          !part ||
          [...part].some(
            (char) => !"abcdefghijklmnopqrstuvwxyz0123456789".includes(char),
          ),
      )
  )
    fail(
      "Use 3–68 lowercase letters, numbers or single hyphens for the store link.",
    );
  return value;
}
function image(value = "") {
  if (value === "") return "";
  if (typeof value !== "string" || value.length > 240000)
    fail("Choose a smaller image.");
  const [header, encoded, extra] = value.split(",");
  const type = {
    "data:image/png;base64": "png",
    "data:image/jpeg;base64": "jpeg",
    "data:image/webp;base64": "webp",
  }[header];
  if (
    !["png", "jpeg", "webp"].includes(type) ||
    !encoded ||
    extra !== undefined
  )
    fail("Choose a PNG, JPEG or WebP image.");
  const b = Buffer.from(encoded, "base64");
  if (b.toString("base64").replace(/=+$/, "") !== encoded.replace(/=+$/, ""))
    fail("Invalid image.");
  const ok =
    type === "jpeg"
      ? b[0] === 255 && b[1] === 216 && b[2] === 255
      : type === "png"
        ? b.subarray(0, 8).toString("hex") === "89504e470d0a1a0a"
        : b.toString("ascii", 0, 4) === "RIFF" &&
          b.toString("ascii", 8, 12) === "WEBP";
  if (!ok) fail("Invalid image.");
  return value;
}
function integer(value, min = 0) {
  if (!Number.isSafeInteger(value) || value < min || value > 2147483647)
    fail("Invalid quantity.");
  return value;
}
async function transaction(fn) {
  const c = await db.connect();
  try {
    await c.query("BEGIN");
    const result = await fn(c);
    await c.query("COMMIT");
    return result;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
const publicFields =
  "id,name,slug,description,category,contact,pickup,logo,cover";
async function catalog(storeId, owner = false, client = db) {
  return (
    await client.query(
      `SELECT p.id,p.name,p.description,p.photo,p.price,c.name AS category,i.quantity
    ${owner ? ",p.archived,p.low_stock_threshold" : ""}
    FROM products p JOIN inventory i ON i.product_id=p.id JOIN categories c ON c.id=p.category_id
    WHERE p.store_id=$1 AND ($2 OR NOT p.archived) ORDER BY p.id DESC`,
      [storeId, owner],
    )
  ).rows;
}
const live = require("../services/market-live.service");
router.get("/live", live.attach);
router.get("/owner/live", auth, live.attach);
router.get("/stores", async (req, res) => {
  const search = text(req.query.q ?? "", 120, false);
  const category = text(req.query.category ?? "", 100, false);
  const [stores, categories] = await Promise.all([
    db.query(
      `SELECT s.name,s.slug,s.description,s.category,s.logo,s.cover,
          COALESCE((
            SELECT json_agg(json_build_object(
              'id', p.id::text, 'name', p.name, 'price', p.price::text, 'quantity', i.quantity
            ) ORDER BY p.id DESC)
            FROM products p JOIN inventory i ON i.product_id=p.id
            WHERE p.store_id=s.id AND NOT p.archived
          ), '[]'::json) AS products
       FROM stores s
       WHERE s.published AND strpos(lower(s.name), lower($1)) > 0
         AND ($2 = '' OR lower(s.category) = lower($2))
       ORDER BY s.name,s.id`,
      [search, category],
    ),
    db.query(
      "SELECT DISTINCT category FROM stores WHERE published ORDER BY category",
    ),
  ]);
  res.json({
    stores: stores.rows,
    categories: categories.rows.map((row) => row.category),
  });
});
router.get("/stores/:slug", async (req, res) => {
  const storefront = await transaction(async (client) => {
    const store = (
      await client.query(
        `SELECT ${publicFields} FROM stores WHERE slug=$1 AND published FOR SHARE`,
        [req.params.slug],
      )
    ).rows[0];
    if (!store) fail("This store is unavailable.", 404);
    return { store, products: await catalog(store.id, false, client) };
  });
  res.json(storefront);
});
router.post("/stores/:slug/orders", auth, async (req, res) => {
  try {
    const details = req.body?.buyerDetails || {};
    const buyerDetails = {};
    for (const [field, max] of Object.entries({
      name: 120,
      phone: 28,
      address: 250,
      city: 100,
      region: 100,
      postalCode: 20,
      country: 100,
    })) {
      if (
        typeof details[field] !== "string" ||
        !details[field].trim() ||
        details[field].trim().length > max
      )
        fail("Enter a valid " + field + ".");
      buyerDetails[field] = details[field].trim();
    }
    if (!validPhone(buyerDetails.phone))
      fail("Enter a valid contact phone number.");
    const order = await createOrder(
      req.user.id,
      req.body?.items,
      db,
      undefined,
      slug(req.params.slug),
      buyerDetails,
    );
    res.status(201).json({ order });
  } catch (e) {
    if ([400, 401, 404, 409].includes(e.statusCode))
      fail(e.message, e.statusCode);
    throw e;
  }
});
router.get("/purchases", auth, async (req, res) => {
  res.json({
    orders: (
      await db.query(
        `SELECT o.id,o.status,o.total_amount,o.created_at,o.pickup_snapshot,
    COALESCE(s.name,'InvenKai') store_name, s.slug FROM orders o LEFT JOIN stores s ON s.id=o.store_id
    WHERE o.user_id=$1 ORDER BY o.created_at DESC,o.id DESC`,
        [req.user.id],
      )
    ).rows,
  });
});
router.use("/owner", auth, async (req, res, next) => {
  req.store = (
    await db.query("SELECT * FROM stores WHERE owner_id=$1", [req.user.id])
  ).rows[0];
  next();
});
router.get("/owner", (req, res) => res.json({ store: req.store || null }));
// Suggestions are shared. Custom names come only from this owner's records.
const defaultCategories = [
  "Books & stationery",
  "Clothing",
  "Electronics",
  "Food & groceries",
  "Health & beauty",
  "Home goods",
  "Sports & outdoors",
  "Toys & games",
];
router.get("/owner/categories", async (req, res) => {
  const { rows } = await db.query(
    `SELECT category FROM stores WHERE owner_id=$1
     UNION
     SELECT c.name FROM stores s JOIN products p ON p.store_id=s.id
       JOIN categories c ON c.id=p.category_id WHERE s.owner_id=$1
     ORDER BY 1`,
    [req.user.id],
  );
  res.json({
    categories: [
      ...new Set([...defaultCategories, ...rows.map((row) => row.category)]),
    ],
  });
});
router.get("/owner/availability", async (req, res) => {
  const value = slug(req.query.slug);
  res.json({
    available: !(
      await db.query("SELECT 1 FROM stores WHERE slug=$1 AND owner_id<>$2", [
        value,
        req.user.id,
      ])
    ).rowCount,
  });
});
router.put("/owner", async (req, res) => {
  const b = req.body || {},
    values = [
      req.user.id,
      text(b.name, 120),
      slug(b.slug),
      text(b.description, 1200, false),
      text(b.category, 100),
      text(b.contact, 254),
      text(b.pickup, 500),
      image(b.logo),
      image(b.cover),
    ];
  const result = await db.query(
    `INSERT INTO stores(owner_id,name,slug,description,category,contact,pickup,logo,cover)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(owner_id) DO UPDATE SET
    name=excluded.name,slug=excluded.slug,description=excluded.description,category=excluded.category,
    contact=excluded.contact,pickup=excluded.pickup,logo=excluded.logo,cover=excluded.cover
    WHERE NOT stores.slug_locked OR stores.slug=excluded.slug RETURNING *`,
    values,
  );
  if (!result.rowCount) fail("Published store links are permanent.", 409);
  res.json({ store: result.rows[0] });
});
router.use("/owner", (req, res, next) =>
  req.store
    ? next()
    : res.status(404).json({ message: "Set up your store first." }),
);
router.put("/owner/publication", async (req, res) => {
  if (typeof req.body?.published !== "boolean")
    fail("Choose a publication state.");
  const result = await db.query(
    `UPDATE stores SET published=$2,slug_locked=slug_locked OR $2 WHERE id=$1
    AND (NOT $2 OR EXISTS(SELECT FROM products WHERE store_id=$1 AND NOT archived)) RETURNING *`,
    [req.store.id, req.body.published],
  );
  if (!result.rowCount) fail("Add an active product before publishing.", 409);
  res.json({ store: result.rows[0] });
});
router.get("/owner/products", async (req, res) =>
  res.json({ products: await catalog(req.store.id, true) }),
);
async function saveProduct(req, res) {
  const b = req.body || {},
    name = text(b.name, 200),
    desc = text(b.description, 1500, false),
    cat = text(b.category, 100),
    photo = image(b.photo);
  if (
    typeof b.price !== "number" ||
    !Number.isFinite(b.price) ||
    b.price < 0 ||
    b.price > 99999999.99 ||
    Number(b.price.toFixed(2)) !== b.price
  )
    fail("Enter a valid price.");
  const threshold =
    b.low_stock_threshold == null ? null : integer(b.low_stock_threshold);
  const id = await transaction(async (c) => {
    let category = (
      await c.query(
        "INSERT INTO categories(name) VALUES($1) ON CONFLICT(name) DO NOTHING RETURNING id",
        [cat],
      )
    ).rows[0];
    if (!category)
      category = (
        await c.query("SELECT id FROM categories WHERE name=$1", [cat])
      ).rows[0];
    const common = [
      name,
      desc,
      b.price,
      photo,
      category.id,
      threshold,
      req.store.id,
    ];
    if (req.params.id) {
      const result = await c.query(
        `UPDATE products SET name=$1,description=$2,price=$3,photo=$4,category_id=$5,low_stock_threshold=$6,updated_at=NOW()
        WHERE store_id=$7 AND id=$8 RETURNING id`,
        [...common, req.params.id],
      );
      if (!result.rowCount) fail("Product not found.", 404);
      return result.rows[0].id;
    }
    const result = await c.query(
      `INSERT INTO products(name,description,price,photo,category_id,low_stock_threshold,store_id,sku)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [...common, randomUUID()],
    );
    const id = result.rows[0].id,
      qty = integer(b.quantity);
    await c.query("INSERT INTO inventory(product_id,quantity) VALUES($1,$2)", [
      id,
      qty,
    ]);
    if (qty)
      await c.query(
        "INSERT INTO inventory_transactions(product_id,performed_by,transaction_type,quantity,quantity_before,quantity_after) VALUES($1,$2,'increase',$3,0,$3)",
        [id, req.user.id, qty],
      );
    return id;
  });
  res.status(req.params.id ? 200 : 201).json({ id });
}
router.post("/owner/products", saveProduct);
router.put("/owner/products/:id", saveProduct);
router.patch("/owner/products/:id/visibility", async (req, res) => {
  if (typeof req.body?.archived !== "boolean")
    fail("Choose a product visibility.");
  const r = await db.query(
    "UPDATE products SET archived=$3 WHERE id=$1 AND store_id=$2",
    [req.params.id, req.store.id, req.body.archived],
  );
  if (!r.rowCount) fail("Product not found.", 404);
  res.sendStatus(204);
});
router.post("/owner/products/:id/stock", async (req, res) => {
  const delta =
    integer(Math.abs(req.body?.delta), 1) * Math.sign(req.body.delta);
  if (typeof req.body.delta !== "number") fail("Invalid adjustment.");
  await transaction(async (c) => {
    const r = await c.query(
      "SELECT i.quantity FROM inventory i JOIN products p ON p.id=i.product_id WHERE p.id=$1 AND p.store_id=$2 FOR UPDATE OF p,i",
      [req.params.id, req.store.id],
    );
    if (!r.rowCount) fail("Product not found.", 404);
    const before = r.rows[0].quantity,
      after = before + delta;
    if (after < 0 || after > 2147483647)
      fail("Adjustment exceeds available stock or capacity.", 409);
    await c.query(
      "UPDATE inventory SET quantity=$2,updated_at=NOW() WHERE product_id=$1",
      [req.params.id, after],
    );
    await c.query(
      "INSERT INTO inventory_transactions(product_id,performed_by,transaction_type,quantity,quantity_before,quantity_after) VALUES ($1,$2,$3,$4,$5,$6)",
      [
        req.params.id,
        req.user.id,
        delta > 0 ? "increase" : "decrease",
        Math.abs(delta),
        before,
        after,
      ],
    );
  });
  res.sendStatus(204);
});
router.get("/owner/history", async (req, res) =>
  res.json({
    history: (
      await db.query(
        `SELECT t.id,t.created_at,p.name,t.transaction_type,t.quantity,t.quantity_after
  FROM inventory_transactions t JOIN products p ON p.id=t.product_id WHERE p.store_id=$1 ORDER BY t.id DESC LIMIT 100`,
        [req.store.id],
      )
    ).rows,
  }),
);
router.get("/owner/orders", async (req, res) =>
  res.json({
    orders: (
      await db.query(
        `SELECT o.id,o.status,o.created_at,o.total_amount,u.name AS buyer FROM orders o JOIN users u ON u.id=o.user_id WHERE o.store_id=$1 ORDER BY o.id DESC`,
        [req.store.id],
      )
    ).rows,
  }),
);
router.get("/owner/orders/:id", async (req, res) => {
  const order = (
    await db.query(
      `SELECT o.id,o.created_at,o.status,o.total_amount,o.pickup_snapshot,o.buyer_details,u.name AS buyer,u.email FROM orders o JOIN users u ON u.id=o.user_id WHERE o.id=$1 AND o.store_id=$2`,
      [req.params.id, req.store.id],
    )
  ).rows[0];
  if (!order) fail("Order not found.", 404);
  order.items = (
    await db.query(
      "SELECT product_name,quantity,unit_price,line_total FROM order_items WHERE order_id=$1 ORDER BY id",
      [order.id],
    )
  ).rows;
  res.json({ order });
});
router.patch("/owner/orders/:id", async (req, res) => {
  const previous = { processing: "placed", completed: "processing" }[
    req.body?.status
  ];
  if (typeof previous !== "string") fail("Invalid fulfillment status.");
  const r = await db.query(
    "UPDATE orders SET status=$1,updated_at=NOW() WHERE id=$2 AND store_id=$3 AND status=$4 RETURNING id",
    [req.body.status, req.params.id, req.store.id, previous],
  );
  if (!r.rowCount) fail("Order unavailable or status already changed.", 409);
  res.sendStatus(204);
});
router.use((e, req, res, next) => {
  if (e.marketStatus)
    return res.status(e.marketStatus).json({ message: e.message });
  if (e.code === "23505")
    return res
      .status(409)
      .json({ message: "That store link is already in use." });
  if (["22P02", "22003"].includes(e.code))
    return res.status(400).json({ message: "Invalid record ID." });
  next(e);
});
module.exports = router;
