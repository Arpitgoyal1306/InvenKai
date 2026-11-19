// Explicit local demo data. Existing stores, catalog edits and stock are preserved on reruns.
const fs = require("node:fs");
const path = require("node:path");
const { randomBytes } = require("node:crypto");
const bcrypt = require("bcrypt");
const pool = require("../config/database");
const shops = [
  {
    slug: "hearth-and-grain",
    name: "Hearth & Grain",
    category: "Bakery",
    cover: "bakery",
    description:
      "A sample neighborhood bakery for slow-fermented loaves and butter pastries.",
    pickup: "Bakery counter, 12 Market Lane",
    items: [
      [
        "Country sourdough",
        "A sliced country loaf with a crisp crust.",
        "sourdough",
        180,
        14,
      ],
      [
        "Butter croissant",
        "One flaky, golden all-butter croissant.",
        "croissant",
        95,
        24,
      ],
    ],
  },
  {
    slug: "stillwater-coffee",
    name: "Stillwater Coffee",
    category: "Coffee",
    cover: "roaster",
    description:
      "A sample roastery offering whole beans and small-batch filter coffee.",
    pickup: "Coffee bar, 8 Market Lane",
    items: [
      [
        "House blend beans",
        "A 250 g bag of whole roasted coffee beans.",
        "beans",
        340,
        20,
      ],
      [
        "Hand-brewed filter coffee",
        "One pour-over brewed fresh for collection.",
        "roaster",
        150,
        18,
      ],
    ],
  },
  {
    slug: "market-garden",
    name: "Market Garden",
    category: "Fresh produce",
    cover: "tomatoes",
    description:
      "A sample greengrocer with seasonal vegetables sold by the bunch and basket.",
    pickup: "Produce stand, 3 Market Lane",
    items: [
      ["Vine tomatoes", "A 500 g basket of ripe tomatoes.", "tomatoes", 75, 18],
      ["Fresh broccoli", "One fresh head of broccoli.", "broccoli", 65, 16],
    ],
  },
];
function photo(name) {
  return (
    "data:image/jpeg;base64," +
    fs
      .readFileSync(
        path.resolve(
          __dirname,
          "../../../client/public/images/sample-shops",
          name + ".jpg",
        ),
      )
      .toString("base64")
  );
}
async function seed() {
  if (process.env.NODE_ENV === "production")
    throw new Error("Use a local demo database.");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const shop of shops) {
      const email = shop.slug + "@sample.invenkai.invalid";
      const found = await client.query(
        "SELECT u.email FROM stores s JOIN users u ON u.id=s.owner_id WHERE s.slug=$1",
        [shop.slug],
      );
      if (found.rowCount) {
        if (found.rows[0].email !== email)
          throw new Error(
            "Store link already belongs to another seller: " + shop.slug,
          );
        continue;
      }
      const hash = await bcrypt.hash(randomBytes(32).toString("hex"), 10);
      const user = (
        await client.query(
          "INSERT INTO users(name,email,password_hash,role) VALUES($1,$2,$3,'customer') RETURNING id",
          [shop.name, email, hash],
        )
      ).rows[0];
      const store = (
        await client.query(
          `INSERT INTO stores(owner_id,name,slug,description,category,contact,pickup,cover,published,slug_locked)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,true,true) RETURNING id`,
          [
            user.id,
            shop.name,
            shop.slug,
            shop.description,
            shop.category,
            "Ask at the pickup counter",
            shop.pickup,
            photo(shop.cover),
          ],
        )
      ).rows[0];
      await client.query(
        "INSERT INTO categories(name) VALUES($1) ON CONFLICT DO NOTHING",
        [shop.category],
      );
      for (const [name, description, image, price, quantity] of shop.items) {
        const {
          rows: [product],
        } = await client.query(
          `INSERT INTO products(store_id,category_id,name,description,photo,price,sku,low_stock_threshold)
          SELECT $1,id,$3,$4,$5,$6,$7,4 FROM categories WHERE name=$2 RETURNING id`,
          [
            store.id,
            shop.category,
            name,
            description,
            photo(image),
            price,
            shop.slug + "-" + image,
          ],
        );
        await client.query(
          "INSERT INTO inventory(product_id,quantity) VALUES($1,$2)",
          [product.id, quantity],
        );
        await client.query(
          "INSERT INTO inventory_transactions(product_id,performed_by,transaction_type,quantity,quantity_before,quantity_after) VALUES($1,$2,'increase',$3,0,$3)",
          [product.id, user.id, quantity],
        );
      }
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
seed()
  .catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
