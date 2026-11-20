import React, { useRef, useState } from "react";
import {
  Link,
  Routes,
  Route,
  Navigate,
  useNavigate,
  useSearchParams,
} from "react-router-dom";
import { Store, Package, ShoppingBag, TriangleAlert } from "lucide-react";
import { api, amount, dateTime, useData } from "./api";
import { State, Table, Modal } from "./ui";
import {
  Catalog,
  Filters,
  MarketPager,
  useMarketPage,
  OrderDetail,
  useAction,
  useMarket,
} from "./Market";
import { defaultLowStock, isLowStock } from "./stockAlerts";
const root = "/market/owner";
const storeUrl = (s) => window.location.origin + "/s/" + s.slug;
function Upload({ label, value, onChange }) {
  const [error, E] = useState(""),
    [pending, P] = useState(false);
  const revision = useRef(0);
  async function change(e) {
    const input = e.currentTarget;
    const request = ++revision.current;
    const file = input.files[0];
    if (!file) {
      input.setCustomValidity("");
      P(false);
      E("");
      return;
    }
    input.setCustomValidity("Please wait for the image to finish processing.");
    const url = URL.createObjectURL(file);
    P(true);
    E("");
    try {
      if (!["image/jpeg", "image/png", "image/webp"].includes(file.type))
        throw Error("Choose a JPEG, PNG or WebP image.");
      const img = new Image();
      img.src = url;
      await img.decode();
      const canvas = document.createElement("canvas"),
        scale = Math.min(1, 800 / img.width, 600 / img.height);
      canvas.width = Math.max(1, img.width * scale);
      canvas.height = Math.max(1, img.height * scale);
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "white";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      let data = canvas.toDataURL("image/jpeg", 0.74);
      if (data.length > 240000) data = canvas.toDataURL("image/jpeg", 0.45);
      if (data.length > 240000) throw Error("Choose a smaller image.");
      if (request === revision.current) {
        input.setCustomValidity("");
        onChange(data);
      }
    } catch (e) {
      if (request === revision.current) {
        input.value = "";
        input.setCustomValidity("");
        E(e.message);
      }
    } finally {
      URL.revokeObjectURL(url);
      if (request === revision.current) P(false);
    }
  }
  return (
    <label>
      {label}
      {value && (
        <img className="upload-preview" src={value} alt={label + " preview"} />
      )}
      <input
        type="file"
        accept="image/jpeg,image/png,image/webp"
        onChange={change}
      />
      {pending && <span role="status">Preparing image…</span>}
      {value && (
        <button type="button" onClick={() => onChange("")}>
          Remove image
        </button>
      )}
      {error && <span role="alert">{error}</span>}
    </label>
  );
}
function PublicLink({ store }) {
  const [msg, M] = useState("");
  return (
    <div className="store-link">
      <code>{storeUrl(store)}</code>
      {store.published && (
        <>
          <button
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(storeUrl(store));
                M("Link copied.");
              } catch {
                M("Select the address above to copy it.");
              }
            }}
          >
            Copy store link
          </button>
          <Link to={"/s/" + store.slug}>Open storefront ↗</Link>
        </>
      )}
      <span role="status">{msg}</span>
    </div>
  );
}
function Publication({ store }) {
  const { act, busy, message } = useAction();
  return (
    <div className="market-actions">
      <b>{store.published ? "Published" : "Draft"}</b>
      <button
        disabled={busy}
        onClick={() =>
          act(
            () =>
              api(root + "/publication", {
                method: "PUT",
                body: { published: !store.published },
              }),
            store.published ? "Store is now a draft." : "Store published.",
          )
        }
      >
        {store.published ? "Unpublish store" : "Publish store"}
      </button>
      <span role="status">{message}</span>
    </div>
  );
}
function CategoryOptions({ id }) {
  const options = useData(root + "/categories");
  return (
    <datalist id={id}>
      {options.data?.categories.map((category) => (
        <option key={category} value={category} />
      ))}
    </datalist>
  );
}
function Settings({ store }) {
  const [v, V] = useState(
      store || {
        name: "",
        slug: "",
        category: "",
        description: "",
        contact: "",
        pickup: "",
        cover: "",
        logo: "",
      },
    ),
    [edited, E] = useState(!!store),
    [available, A] = useState(""),
    { act, message, busy } = useAction(),
    nav = useNavigate();
  const set = (key, value) => V((prev) => ({ ...prev, [key]: value }));
  async function submit(e) {
    e.preventDefault();
    if (
      (await act(
        () => api(root, { method: "PUT", body: v }),
        "Store details saved.",
      )) &&
      !store
    )
      nav("/owner/products?new=1");
  }
  return (
    <>
      <div className="market-title settings-heading">
        <h1>{store ? "Store settings" : "Set up your store"}</h1>
        <strong
          className="order-status"
          data-status={store?.published ? "completed" : "draft"}
        >
          {store?.published ? "Published" : "Draft"}
        </strong>
      </div>
      <div className="store-settings-layout">
        <form className="settings-form" onSubmit={submit}>
          <fieldset disabled={busy}>
            <section className="market-panel settings-section">
              <h2>Store details</h2>
              <div className="settings-fields">
                <label>
                  Store name
                  <input
                    required
                    maxLength="120"
                    value={v.name}
                    onChange={(e) => {
                      const name = e.target.value;
                      V({
                        ...v,
                        name,
                        ...(!edited
                          ? {
                              slug: name
                                .toLowerCase()
                                .replace(/[^a-z0-9]+/g, "-")
                                .replace(/^-|-$/g, "")
                                .slice(0, 68),
                            }
                          : {}),
                      });
                    }}
                  />
                </label>
                <label>
                  What do you sell?
                  <input
                    required
                    maxLength="100"
                    list="store-categories"
                    placeholder="Choose or enter a store category"
                    value={v.category}
                    onChange={(e) => set("category", e.target.value)}
                  />
                </label>
                <CategoryOptions id="store-categories" />
                <label className="wide-field">
                  Description
                  <textarea
                    maxLength="1200"
                    value={v.description}
                    onChange={(e) => set("description", e.target.value)}
                  />
                </label>
              </div>
            </section>
            <section className="market-panel settings-section">
              <h2>Contact and pickup</h2>
              <div className="settings-fields">
                <label>
                  Public business contact
                  <input
                    required
                    maxLength="254"
                    value={v.contact}
                    onChange={(e) => set("contact", e.target.value)}
                  />
                </label>
                <label>
                  Pickup location and instructions
                  <input
                    required
                    maxLength="500"
                    value={v.pickup}
                    onChange={(e) => set("pickup", e.target.value)}
                  />
                </label>
              </div>
            </section>
            <section className="market-panel settings-section">
              <h2>Store link and appearance</h2>
              <div className="settings-fields">
                <label className="wide-field">
                  Store link
                  <input
                    required
                    minLength="3"
                    maxLength="68"
                    readOnly={store?.slug_locked}
                    pattern="[a-z0-9]+(-[a-z0-9]+)*"
                    value={v.slug}
                    onChange={(e) => {
                      E(true);
                      A("");
                      set("slug", e.target.value);
                    }}
                    onBlur={async (e) => {
                      const value = e.target.value;
                      if (!value || store?.slug_locked) return;
                      try {
                        const r = await api(
                          root +
                            "/availability?slug=" +
                            encodeURIComponent(value),
                        );
                        A(
                          r.available
                            ? "Link available."
                            : "Link already in use.",
                        );
                      } catch (err) {
                        A(err.message);
                      }
                    }}
                  />
                  <small>
                    {storeUrl(v)} ·{" "}
                    {store?.slug_locked
                      ? "Permanent link"
                      : available || "Permanent after first publication"}
                  </small>
                </label>
                <Upload
                  label="Store logo"
                  value={v.logo}
                  onChange={(x) => set("logo", x)}
                />
                <Upload
                  label="Cover image"
                  value={v.cover}
                  onChange={(x) => set("cover", x)}
                />
              </div>
            </section>
            <div className="settings-actions">
              <button className="primary">
                {store ? "Save store details" : "Save draft and add a product"}
              </button>
              <p role="status">{message}</p>
            </div>
          </fieldset>
        </form>
        {store && (
          <section className="market-panel settings-section storefront-controls">
            <h2>Storefront</h2>
            <PublicLink store={store} />
            <Link to="/owner/preview">Preview store</Link>
            <Publication store={store} />
          </section>
        )}
      </div>
    </>
  );
}
function ProductForm({ product, close }) {
  const [photo, P] = useState(product?.photo || ""),
    { act, message, busy } = useAction();
  async function submit(e) {
    e.preventDefault();
    const b = Object.fromEntries(new FormData(e.currentTarget));
    b.price = Number(b.price);
    b.quantity = Number(b.quantity);
    b.low_stock_threshold =
      b.low_stock_threshold === "" ? null : Number(b.low_stock_threshold);
    b.photo = photo;
    if (
      await act(() =>
        api(root + "/products" + (product ? "/" + product.id : ""), {
          method: product ? "PUT" : "POST",
          body: b,
        }),
      )
    )
      close(true);
  }
  return (
    <Modal
      title={product ? "Edit product" : "Add product"}
      close={() => close(false)}
      busy={busy}
    >
      <form className="market-form" onSubmit={submit}>
        <fieldset disabled={busy}>
          {[
            ["name", "Product name", 200],
            ["category", "Category", 100],
            ["description", "Description", 1500],
          ].map(([k, l, n]) => (
            <label key={k}>
              {l}
              <input
                required={k !== "description"}
                maxLength={n}
                name={k}
                list={k === "category" ? "product-categories" : undefined}
                placeholder={
                  k === "category" ? "Choose or enter a category" : undefined
                }
                defaultValue={product?.[k] || ""}
              />
            </label>
          ))}
          <CategoryOptions id="product-categories" />
          <label>
            Price
            <input
              name="price"
              type="number"
              min="0"
              step=".01"
              required
              defaultValue={product?.price}
            />
          </label>
          {!product && (
            <label>
              Opening stock
              <input
                name="quantity"
                type="number"
                min="0"
                required
                defaultValue="0"
              />
            </label>
          )}
          <label>
            Low-stock threshold
            <input
              name="low_stock_threshold"
              type="number"
              min="0"
              defaultValue={product?.low_stock_threshold ?? ""}
            />
            <small>Defaults to {defaultLowStock} units when blank.</small>
          </label>
          <Upload label="Product photo" value={photo} onChange={P} />
          <button className="primary">Save product</button>
          <p role="alert">{message}</p>
        </fieldset>
      </form>
    </Modal>
  );
}
function History() {
  const listing = useMarketPage(root + "/history");
  const q = listing.query;
  return (
    <>
      <State
        query={q}
        empty={!q.data?.history.length}
        message={
          listing.page === 1
            ? "No stock movements yet."
            : "No stock movements on this page."
        }
      >
        <Table
          heads={["Date", "Product", "Change", "Stock after"]}
          rows={(q.data?.history || []).map((t) => ({
            key: t.id,
            cells: [
              dateTime(t.created_at),
              t.name,
              t.transaction_type + " " + t.quantity,
              t.quantity_after,
            ],
          }))}
        />
      </State>
      <MarketPager listing={listing} />
    </>
  );
}
function Products() {
  const [params, setParams] = useSearchParams(),
    [form, F] = useState(params.has("new") ? {} : null),
    [adjust, J] = useState(null),
    [history, H] = useState(false),
    [notice, N] = useState(""),
    [search, S] = useState(""),
    [cat, C] = useState(""),
    { act, busy, message } = useAction(),
    lowOnly = params.get("stock") === "low";
  const listing = useMarketPage(root + "/products", {
    q: search.trim(),
    category: cat,
    stock: lowOnly ? "low" : "",
  });
  const q = listing.query;
  const shown = q.data?.products || [];
  return (
    <>
      <div className="market-title">
        <h1>Products</h1>
        <button className="primary" onClick={() => F({})}>
          Add product
        </button>
      </div>
      <div className="market-actions">
        <button
          aria-pressed={lowOnly}
          onClick={() => setParams(lowOnly ? {} : { stock: "low" })}
        >
          {lowOnly ? "Show all products" : "Show low stock"}
        </button>
      </div>
      <Filters
        categories={q.data?.categories || []}
        search={search}
        setSearch={S}
        category={cat}
        setCategory={C}
        label="Search products"
      />
      <p role="status">{notice || message}</p>
      <State query={q} empty={!shown.length} message="No products found.">
        <div className="market-panel">
          {shown.map((p) => (
            <div className="market-row" key={p.id}>
              {p.photo && <img className="thumb" src={p.photo} alt="" />}
              <div>
                <b>{p.name}</b>
                <small>
                  {p.category} · {amount(p.price)} · {p.quantity} in stock{" "}
                  {p.archived ? "· Archived" : ""}
                </small>
                {isLowStock(p) && (
                  <span className="stock-warning">
                    {p.quantity ? "Low stock" : "Out of stock"}
                  </span>
                )}
              </div>
              <button onClick={() => F(p)}>Edit</button>
              <button onClick={() => J(p)}>Adjust stock</button>
              <button
                disabled={busy}
                onClick={() => {
                  N("");
                  act(
                    () =>
                      api(root + "/products/" + p.id + "/visibility", {
                        method: "PATCH",
                        body: { archived: !p.archived },
                      }),
                    "Visibility updated.",
                  );
                }}
              >
                {p.archived ? "Restore" : "Archive"}
              </button>
            </div>
          ))}
        </div>
      </State>
      <MarketPager listing={listing} />
      <div className="market-actions">
        <Link to="/owner/preview">Preview store →</Link>
        <button onClick={() => H(!history)}>
          {history ? "Hide" : "Show"} inventory history
        </button>
      </div>
      {history && <History />}
      {form && (
        <ProductForm
          product={form.id ? form : null}
          close={(saved) => {
            F(null);
            setParams({}, { replace: true });
            if (saved) N("Product saved.");
          }}
        />
      )}
      {adjust && (
        <Modal
          title={"Adjust stock · " + adjust.name}
          close={() => J(null)}
          busy={busy}
        >
          <form
            className="market-form"
            onSubmit={async (e) => {
              e.preventDefault();
              const delta = Number(new FormData(e.currentTarget).get("delta"));
              N("");
              if (
                await act(
                  () =>
                    api(root + "/products/" + adjust.id + "/stock", {
                      method: "POST",
                      body: { delta },
                    }),
                  "Stock updated.",
                )
              )
                J(null);
            }}
          >
            <label>
              Units to add or subtract
              <input
                type="number"
                required
                name="delta"
                placeholder="e.g. 5 or -2"
              />
            </label>
            <button disabled={busy}>Apply adjustment</button>
            <p role="alert">{message}</p>
          </form>
        </Modal>
      )}
    </>
  );
}
function Incoming() {
  const [search, S] = useState(""),
    [status, T] = useState(""),
    [date, D] = useState(""),
    [selected, O] = useState(null);
  const day = date ? new Date(date + "T00:00:00") : null;
  const utcOffset = day?.getTimezoneOffset();
  if (day) day.setDate(day.getDate() + 1);
  const listing = useMarketPage(root + "/orders", {
    q: search.trim().replace("#", ""),
    status,
    date,
    utcOffset,
    endOffset: day?.getTimezoneOffset(),
  });
  const q = listing.query;
  const shown = q.data?.orders || [];
  return (
    <>
      <h1>Incoming orders</h1>
      <div className="market-filters">
        <input
          aria-label="Search order number"
          placeholder="Search order number"
          value={search}
          onChange={(e) => S(e.target.value)}
        />
        <select
          aria-label="Fulfillment status"
          value={status}
          onChange={(e) => T(e.target.value)}
        >
          <option value="">All statuses</option>
          {["placed", "processing", "completed", "cancelled"].map((x) => (
            <option key={x}>{x}</option>
          ))}
        </select>
        <input
          aria-label="Order date"
          type="date"
          value={date}
          onChange={(e) => D(e.target.value)}
        />
      </div>
      <State
        query={q}
        empty={!shown.length}
        message="No incoming orders match."
      >
        <Table
          heads={["Order", "Date", "Buyer", "Total", "Status", "Details"]}
          rows={shown.map((o) => ({
            key: o.id,
            cells: [
              "#" + o.id,
              dateTime(o.created_at),
              o.buyer,
              amount(o.total_amount),
              o.status,
              <button onClick={() => O(o)}>View order</button>,
            ],
          }))}
        />
      </State>
      <MarketPager listing={listing} />
      {selected && <OrderDetail owner order={selected} close={() => O(null)} />}
    </>
  );
}
function Overview({ store }) {
  const summary = useMarket(root + "/summary");
  const {
    activeProducts = 0,
    lowProducts = 0,
    newOrders = 0,
    sales = 0,
    alerts = [],
  } = summary.data || {};
  return (
    <>
      <div
        className={
          "market-title owner-masthead" + (store.cover ? " with-cover" : "")
        }
        style={
          store.cover
            ? {
                backgroundImage:
                  "linear-gradient(90deg,#18352ff2,#18352f80),url(" +
                  store.cover +
                  ")",
              }
            : undefined
        }
      >
        <h1>{store.name}</h1>
        <strong>{store.published ? "Published" : "Draft"}</strong>
      </div>
      <div className="market-actions">
        <Link className="primary" to="/owner/products?new=1">
          Add product
        </Link>
        <Link to="/owner/orders">View incoming orders</Link>
        <Link to="/owner/preview">Preview store</Link>
      </div>
      <State query={summary}>
        {!store.published && (
          <section className="market-panel">
            <h2>
              {activeProducts ? "Publish your store" : "Add your first product"}
            </h2>
            <p>
              {activeProducts
                ? "Publish to list your store and its active products in Explore stores."
                : "Your draft is saved. Add a product with its price and opening stock."}
            </p>
            {activeProducts > 0 && <Publication store={store} />}
          </section>
        )}
        <div className="market-metrics">
          {[
            [ShoppingBag, "New orders", newOrders],
            [Store, "Order value · last 30 days", amount(sales)],
            [Package, "Active products", activeProducts],
            [TriangleAlert, "Low-stock products", lowProducts],
          ].map(([Icon, label, value]) => (
            <section key={label}>
              <Icon size={20} />
              <small>{label}</small>
              <b>{value}</b>
            </section>
          ))}
        </div>
        {lowProducts > 0 && (
          <section className="market-panel">
            <h2>Low-stock alerts</h2>
            {alerts.map((p) => (
              <div className="market-row" key={p.id}>
                <b>{p.name}</b>
                <span>{p.quantity} remaining</span>
                <Link to="/owner/products?stock=low">Manage stock</Link>
              </div>
            ))}
          </section>
        )}
      </State>
      <PublicLink store={store} />
    </>
  );
}
function Preview({ store }) {
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("");
  const q = useMarketPage(root + "/products", {
    q: search.trim(),
    category,
    visibility: "public",
  });
  return (
    <>
      <div className="market-title">
        <h2>Store preview</h2>
        <Publication store={store} />
      </div>
      <PublicLink store={store} />
      <Catalog
        store={store}
        listing={q}
        search={search}
        setSearch={setSearch}
        category={category}
        setCategory={setCategory}
      />
    </>
  );
}
export function Owner() {
  const q = useMarket(root),
    s = q.data?.store;
  return (
    <State query={q}>
      {s ? (
        <Routes>
          <Route index element={<Overview store={s} />} />
          <Route path="products" element={<Products />} />
          <Route path="orders" element={<Incoming />} />
          <Route path="settings" element={<Settings key={s.id} store={s} />} />
          <Route path="preview" element={<Preview store={s} />} />
          <Route path="*" element={<Navigate to="/owner" replace />} />
        </Routes>
      ) : (
        <Settings />
      )}
    </State>
  );
}
