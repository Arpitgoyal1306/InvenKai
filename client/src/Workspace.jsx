import { Link, useSearchParams } from "react-router-dom";
import { Receipt, SupplierCatalog } from "./Operations";
import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Boxes,
  Package,
  TriangleAlert,
  Plus,
  ShoppingBasket,
} from "lucide-react";
import { api, amount, dateTime, useData } from "./api";
import { State, Pager, Table, ActionForm, Field, Modal } from "./ui";

const size = 20;
function useWrite() {
  const client = useQueryClient();
  return async (path, method, body, idempotencyKey) => {
    const result = await api(path, { method, body, idempotencyKey });
    await client.invalidateQueries();
    return result;
  };
}
function saveRecord(write, path, original, fields) {
  if (!original.id) return write(path, "POST", fields);
  const changed = Object.entries(fields).filter(([key, value]) => {
    if (key === "price") return Number(original.price) !== value;
    return String(original[key] ?? "") !== String(value ?? "");
  });
  if (changed.length)
    return write(
      path + "/" + original.id,
      "PATCH",
      Object.fromEntries(changed),
    );
}

function Title({ children, action }) {
  return (
    <div className="page-heading">
      <h1>{children}</h1>
      {action}
    </div>
  );
}
function Add({ children, onClick }) {
  return (
    <button className="primary" onClick={onClick}>
      <Plus size={17} />
      {children}
    </button>
  );
}
function RecordDetails({ path, title, close, children }) {
  const q = useData(path);
  return (
    <Modal title={title} close={close}>
      <State query={q}>{q.data && children(q.data)}</State>
    </Modal>
  );
}

export function Overview({ reports = false }) {
  const [category, setCategory] = useState("");
  const audit = useData("/inventory/history?limit=5&offset=0", !reports);
  const today = new Date().toISOString().slice(0, 10);
  const week = new Date(Date.now() - 6 * 86400000).toISOString().slice(0, 10);
  const [range, setRange] = useState({ start: week, end: today });
  const summary = useData("/reports/stock-summary"),
    low = useData("/reports/low-stock"),
    cats = useData("/reports/category-stock");
  const filteredCats = useData(
    "/reports/category-stock?categoryId=" + category,
    Boolean(category),
  );
  const categoryReport = category ? filteredCats : cats;
  const movement = useData(
    `/reports/stock-movement?startDate=${range.start}&endDate=${range.end}`,
  );
  const daily = movement.data?.daily || [];
  const peak = Math.max(
    1,
    ...daily.flatMap((d) => [d.stock_added, d.stock_removed]),
  );
  return (
    <>
      <Title>{reports ? "Reports & analytics" : "Inventory overview"}</Title>
      <div className="metrics">
        {[
          ["Catalog products", summary, summary.data?.product_count, Package],
          ["Units on hand", summary, summary.data?.total_stock_quantity, Boxes],
          ["Low-stock products", low, low.data?.count, TriangleAlert],
        ].map(([name, q, value, Icon]) => (
          <article className="metric" key={name}>
            <Icon size={21} />
            <span>{name}</span>
            <State query={q}>
              <strong>{value?.toLocaleString()}</strong>
            </State>
          </article>
        ))}
      </div>
      {!reports && (
        <div className="overview-grid">
          <section className="panel">
            <div className="panel-title">
              <h2>Low-stock alerts</h2>
              <Link to="/inventory?view=low">View alerts</Link>
            </div>
            <State
              query={low}
              empty={!low.data?.count}
              message="All monitored products are above their threshold."
            >
              <Table
                heads={["Product", "On hand", "Threshold"]}
                rows={(low.data?.products || []).slice(0, 5).map((p) => ({
                  key: p.product_id,
                  cells: [p.name, p.quantity, p.low_stock_threshold],
                }))}
              />
            </State>
          </section>
          <section className="panel">
            <div className="panel-title">
              <h2>Recent activity</h2>
              <Link to="/inventory?view=history">View history</Link>
            </div>
            <State
              query={audit}
              empty={!audit.data?.transactions.length}
              message="No stock changes yet."
            >
              <ul className="activity-list">
                {audit.data?.transactions.map((t) => (
                  <li key={t.id}>
                    <strong>
                      {t.transaction_type === "increase" ? "+" : "−"}
                      {t.quantity} units
                    </strong>
                    <span>
                      Product #{t.product_id} · {dateTime(t.created_at)}
                    </span>
                  </li>
                ))}
              </ul>
            </State>
          </section>
        </div>
      )}
      <section className="panel">
        <h2>Stock movement</h2>
        <form
          className="filters"
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            setRange({ start: f.get("start"), end: f.get("end") });
          }}
        >
          <Field
            label="From (UTC)"
            type="date"
            name="start"
            required
            defaultValue={week}
          />
          <Field
            label="To (UTC)"
            type="date"
            name="end"
            required
            defaultValue={today}
          />
          <button>Apply dates</button>
        </form>
        <State
          query={movement}
          empty={!daily.length}
          message="No stock movements in this period."
        >
          <p className="legend">
            <i /> Added {movement.data?.total_added} <i /> Removed{" "}
            {movement.data?.total_removed} · Net change{" "}
            {movement.data?.net_change}
          </p>
          <div className="chart">
            {daily.map((d) => (
              <div className="chart-row" key={d.date}>
                <span>{d.date}</span>
                <div>
                  <b style={{ width: (100 * d.stock_added) / peak + "%" }} />
                  <b style={{ width: (100 * d.stock_removed) / peak + "%" }} />
                </div>
                <span>
                  +{d.stock_added} / −{d.stock_removed}
                </span>
              </div>
            ))}
          </div>
        </State>
      </section>
      <section className="panel">
        <div className="panel-title">
          <h2>Stock by category</h2>
          {reports && (
            <label>
              Category filter
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value)}
              >
                <option value="">All categories</option>
                {cats.data?.categories.map((c) => (
                  <option key={c.category_id} value={c.category_id}>
                    {c.category_name}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        {reports && summary.data && (
          <p>
            {summary.data.products_with_inventory} products with inventory ·{" "}
            {summary.data.products_without_inventory} without inventory records
          </p>
        )}
        <State
          query={categoryReport}
          empty={!categoryReport.data?.categories.length}
          message="No categories available."
        >
          <Table
            heads={["Category", "Products", "Units on hand"]}
            rows={(categoryReport.data?.categories || []).map((c) => ({
              key: c.category_id,
              cells: [c.category_name, c.product_count, c.total_stock_quantity],
            }))}
          />
        </State>
      </section>
    </>
  );
}

export function Products({ staff, admin, canOrder, addToCart }) {
  const [page, setPage] = useState(1),
    [modal, setModal] = useState(null),
    [notice, setNotice] = useState("");
  const q = useData(`/products?limit=${size}&offset=${(page - 1) * size}`),
    cats = useData("/categories", staff);
  const rows = q.data?.products || [],
    write = useWrite(),
    item = modal?.item || {};
  const close = () => setModal(null);
  return (
    <>
      <Title
        action={
          staff && (
            <div className="actions">
              <button onClick={() => setModal({ type: "category" })}>
                New category
              </button>
              <Add onClick={() => setModal({ type: "create" })}>
                New product
              </Add>
            </div>
          )
        }
      >
        Products
      </Title>
      {modal?.type === "category" && (
        <ActionForm
          title="New category"
          close={close}
          submitLabel="Create category"
          onSubmit={(f) => write("/categories", "POST", f)}
        >
          <Field label="Category name" name="name" required maxLength="100" />
        </ActionForm>
      )}
      {notice && (
        <p role="status" className="notice">
          {notice}
        </p>
      )}
      <section className="panel">
        <h2>Product catalog</h2>
        <State
          query={q}
          empty={!rows.length}
          message="No products on this page."
        >
          <Table
            heads={["Product", "SKU", "Unit price", "Actions"]}
            rows={rows.map((p) => ({
              key: p.id,
              cells: [
                <button
                  className="text"
                  onClick={() => setModal({ type: "detail", item: p })}
                >
                  {p.name}
                </button>,
                <code>{p.sku}</code>,
                amount(p.price),
                <div className="actions">
                  {canOrder && (
                    <button
                      onClick={() => {
                        addToCart(p);
                        setNotice(p.name + " added to cart.");
                      }}
                    >
                      <ShoppingBasket size={15} />
                      Add
                    </button>
                  )}
                  {staff && (
                    <button onClick={() => setModal({ type: "edit", item: p })}>
                      Edit
                    </button>
                  )}
                  {admin && (
                    <button
                      onClick={() => setModal({ type: "delete", item: p })}
                    >
                      Archive
                    </button>
                  )}
                </div>,
              ],
            }))}
          />
        </State>
        <Pager
          page={page}
          setPage={setPage}
          next={
            q.data?.pagination?.total != null
              ? page * size < q.data.pagination.total
              : rows.length === size
          }
        />
      </section>
      {modal?.type === "detail" && (
        <RecordDetails
          path={"/products/" + item.id}
          title={item.name}
          close={close}
        >
          {({ product: p }) => (
            <dl>
              <dt>SKU</dt>
              <dd>{p.sku}</dd>
              <dt>Unit price</dt>
              <dd>{amount(p.price)}</dd>
              <dt>Description</dt>
              <dd>{p.description || "—"}</dd>
              <dt>Category ID</dt>
              <dd>{p.category_id}</dd>
              <dt>Units on hand</dt>
              <dd>
                <Stock id={p.id} />
              </dd>
            </dl>
          )}
        </RecordDetails>
      )}
      {["create", "edit"].includes(modal?.type) && (
        <ActionForm
          title={item.id ? "Edit product" : "New product"}
          close={close}
          onSubmit={(f) =>
            saveRecord(write, "/products", item, {
              ...f,
              price: Number(f.price),
              low_stock_threshold:
                f.low_stock_threshold === ""
                  ? null
                  : Number(f.low_stock_threshold),
            })
          }
        >
          <Field
            label="Product name"
            name="name"
            required
            maxLength="200"
            defaultValue={item.name}
          />
          <Field
            label="SKU"
            name="sku"
            required
            maxLength="100"
            defaultValue={item.sku}
          />
          <label>
            Category
            <select
              aria-label="Category"
              name="category_id"
              defaultValue={item.category_id || ""}
              required
            >
              <option value="" disabled>
                Select category
              </option>
              {(cats.data?.categories || []).map((c) => (
                <option value={c.id} key={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <State
            query={cats}
            empty={!cats.data?.categories.length}
            message="Create a category using New category in Products, then add your product."
          />
          <Field
            label="Unit price"
            name="price"
            type="number"
            required
            min="0"
            max="99999999.99"
            step=".01"
            defaultValue={item.price}
          />
          <Field
            label="Low-stock threshold"
            name="low_stock_threshold"
            type="number"
            min="0"
            max="2147483647"
            defaultValue={item.low_stock_threshold ?? ""}
          />
          <Field
            label="Description"
            name="description"
            defaultValue={item.description || ""}
          />
        </ActionForm>
      )}
      {modal?.type === "delete" && (
        <ActionForm
          title="Archive product"
          close={close}
          submitLabel="Archive product"
          onSubmit={() => write("/products/" + item.id, "DELETE")}
        >
          <p>
            Archive {item.name}? Its inventory and order history will remain
            available.
          </p>
        </ActionForm>
      )}
    </>
  );
}

export function Inventory() {
  const [params, setParams] = useSearchParams();
  const tab =
    { low: "Low stock", history: "History" }[params.get("view")] ||
    "Stock levels";
  const [productFilter, setProductFilter] = useState(""),
    [threshold, setThreshold] = useState(null),
    [page, setPage] = useState(1),
    [item, setItem] = useState(null);
  const write = useWrite();
  const products = useData(
    `/inventory?limit=${size}&offset=${(page - 1) * size}`,
    tab === "Stock levels",
  );
  const low = useData("/inventory/low-stock", tab === "Low stock");
  const history = useData(
    `/inventory/history?limit=${size}&offset=${(page - 1) * size}${productFilter ? "&productId=" + productFilter : ""}`,
    tab === "History",
  );
  const isHistory = tab === "History",
    isLow = tab === "Low stock",
    q = isHistory ? history : isLow ? low : products;
  const rows = (isHistory ? q.data?.transactions : q.data?.products) || [];
  return (
    <>
      <Title>Inventory</Title>
      <div className="tabs">
        {["Stock levels", "Low stock", "History"].map((t) => (
          <button
            key={t}
            aria-pressed={t === tab}
            onClick={() => {
              setParams(
                t === "History"
                  ? { view: "history" }
                  : t === "Low stock"
                    ? { view: "low" }
                    : {},
              );
              setPage(1);
            }}
          >
            {t}
          </button>
        ))}
      </div>
      <section className="panel">
        <h2>{tab}</h2>
        {isHistory && (
          <form
            className="filters"
            onSubmit={(e) => {
              e.preventDefault();
              setPage(1);
              setProductFilter(new FormData(e.currentTarget).get("productId"));
            }}
          >
            <Field
              label="Filter by product ID"
              name="productId"
              type="number"
              min="1"
              step="1"
              placeholder="All products"
            />
            <button>Apply filter</button>
          </form>
        )}
        <State
          query={q}
          empty={!rows.length}
          message={
            isLow
              ? "No products are below their stock threshold."
              : "No records on this page."
          }
        >
          <Table
            heads={
              isHistory
                ? [
                    "Product ID",
                    "Movement",
                    "Quantity",
                    "Before",
                    "After",
                    "User ID",
                    "Recorded",
                  ]
                : [
                    "Product",
                    "SKU",
                    "Units on hand",
                    isLow ? "Threshold" : "Actions",
                  ]
            }
            rows={rows.map((r) => ({
              key: r.id || r.product_id,
              cells: isHistory
                ? [
                    r.product_id,
                    r.transaction_type,
                    r.quantity,
                    r.quantity_before,
                    r.quantity_after,
                    r.performed_by ?? "—",
                    dateTime(r.created_at),
                  ]
                : [
                    r.name,
                    <code>{r.sku}</code>,
                    r.quantity,
                    <div className="actions">
                      {isLow && <strong>{r.low_stock_threshold}</strong>}
                      <button
                        onClick={() =>
                          setItem({ ...r, id: r.product_id || r.id })
                        }
                      >
                        Adjust stock
                      </button>
                      <button
                        onClick={() =>
                          setThreshold({ ...r, id: r.product_id || r.id })
                        }
                      >
                        Set threshold
                      </button>
                    </div>,
                  ],
            }))}
          />
        </State>
        {!isLow && (
          <Pager
            page={page}
            setPage={setPage}
            next={
              q.data?.pagination?.total != null
                ? page * size < q.data.pagination.total
                : rows.length === size
            }
          />
        )}
      </section>
      {threshold && (
        <ActionForm
          title={"Low-stock threshold · " + threshold.name}
          close={() => setThreshold(null)}
          onSubmit={(f) =>
            write("/products/" + threshold.id + "/threshold", "PATCH", {
              low_stock_threshold:
                f.threshold === "" ? null : Number(f.threshold),
            })
          }
        >
          <Field
            label="Alert at or below"
            type="number"
            min="0"
            max="2147483647"
            step="1"
            name="threshold"
            defaultValue={threshold.low_stock_threshold ?? ""}
          />
          <p>Leave blank to disable this alert.</p>
        </ActionForm>
      )}
      {item && (
        <ActionForm
          title={"Adjust stock · " + item.name}
          close={() => setItem(null)}
          onSubmit={(f) =>
            write(`/inventory/${item.id}/${f.direction}`, "PATCH", {
              quantity: Number(f.quantity),
            })
          }
        >
          <label>
            Movement
            <select aria-label="Movement" name="direction">
              <option value="increase">Increase</option>
              <option value="decrease">Decrease</option>
            </select>
          </label>
          <Field
            label="Quantity"
            name="quantity"
            type="number"
            min="1"
            max="2147483647"
            required
            step="1"
          />
        </ActionForm>
      )}
    </>
  );
}
function Stock({ id }) {
  const q = useData("/inventory/" + id);
  if (q.isError)
    return (
      <button onClick={() => q.refetch()} title={q.error.message}>
        Retry stock
      </button>
    );
  return q.data?.inventory?.quantity ?? "…";
}

export function Suppliers({ admin }) {
  const [page, setPage] = useState(1),
    [modal, setModal] = useState(null);
  const q = useData(`/suppliers?limit=${size}&offset=${(page - 1) * size}`),
    rows = q.data?.suppliers || [],
    write = useWrite(),
    item = modal?.item || {};
  const close = () => setModal(null);
  return (
    <>
      <Title
        action={
          <Add onClick={() => setModal({ type: "create" })}>New supplier</Add>
        }
      >
        Suppliers
      </Title>
      <section className="panel">
        <h2>Supplier directory</h2>
        <State
          query={q}
          empty={!rows.length}
          message="No active suppliers on this page."
        >
          <Table
            heads={["Supplier", "Contact", "Email", "Actions"]}
            rows={rows.map((s) => ({
              key: s.id,
              cells: [
                <button
                  className="text"
                  onClick={() => setModal({ type: "detail", item: s })}
                >
                  {s.name}
                </button>,
                s.contact_name || "—",
                s.email || "—",
                <div className="actions">
                  <button onClick={() => setModal({ type: "edit", item: s })}>
                    Edit
                  </button>
                  <button
                    onClick={() => setModal({ type: "catalog", item: s })}
                  >
                    Products
                  </button>
                  {admin && (
                    <button
                      onClick={() => setModal({ type: "delete", item: s })}
                    >
                      Deactivate
                    </button>
                  )}
                </div>,
              ],
            }))}
          />
        </State>
        <Pager
          page={page}
          setPage={setPage}
          next={
            q.data?.pagination?.total != null
              ? page * size < q.data.pagination.total
              : rows.length === size
          }
        />
      </section>
      {modal?.type === "catalog" && (
        <SupplierCatalog supplier={item} close={close} />
      )}
      {modal?.type === "detail" && (
        <RecordDetails
          title={item.name}
          path={"/suppliers/" + item.id}
          close={close}
        >
          {({ supplier: s }) => (
            <dl>
              {["name", "contact_name", "email", "phone"].map((k) => (
                <div key={k}>
                  <dt>{k.replace("_", " ")}</dt>
                  <dd>{s[k] || "—"}</dd>
                </div>
              ))}
            </dl>
          )}
        </RecordDetails>
      )}
      {["create", "edit"].includes(modal?.type) && (
        <ActionForm
          title={item.id ? "Edit supplier" : "New supplier"}
          close={close}
          onSubmit={(f) => saveRecord(write, "/suppliers", item, f)}
        >
          <Field
            label="Supplier name"
            name="name"
            defaultValue={item.name}
            required
          />
          <Field
            label="Contact name"
            name="contact_name"
            defaultValue={item.contact_name || ""}
          />
          <p>Enter an email address or phone number.</p>
          <Field
            label="Email"
            name="email"
            type="email"
            defaultValue={item.email || ""}
          />
          <Field
            label="Phone"
            name="phone"
            type="tel"
            defaultValue={item.phone || ""}
          />
        </ActionForm>
      )}
      {modal?.type === "delete" && (
        <ActionForm
          title="Deactivate supplier"
          close={close}
          submitLabel="Deactivate"
          onSubmit={() => write("/suppliers/" + item.id, "DELETE")}
        >
          <p>Remove {item.name} from the active supplier directory?</p>
        </ActionForm>
      )}
    </>
  );
}

export function Orders({ cart, setCart, canOrder }) {
  const checkoutRequest = useRef(null);
  const [page, setPage] = useState(1),
    [detail, setDetail] = useState(null),
    [checkout, setCheckout] = useState(false);
  const q = useData(`/orders?page=${page}&limit=${size}`),
    write = useWrite(),
    rows = q.data?.orders || [];
  const total =
    cart.reduce(
      (sum, i) => sum + Math.round(Number(i.price) * 100) * i.quantity,
      0,
    ) / 100;
  return (
    <>
      <Title>My orders</Title>
      {canOrder && (
        <section className="panel">
          <h2>Current cart</h2>
          {!cart.length ? (
            <p className="muted">
              Add products from the catalog to place an order.
            </p>
          ) : (
            <>
              <Table
                heads={["Product", "Quantity", "Amount", "Actions"]}
                rows={cart.map((i) => ({
                  key: i.id,
                  cells: [
                    i.name,
                    <input
                      className="qty"
                      aria-label={"Quantity for " + i.name}
                      type="number"
                      min="1"
                      max="2147483647"
                      value={i.quantity}
                      onChange={(e) => {
                        const n = Number(e.target.value);
                        if (Number.isSafeInteger(n) && n > 0 && n <= 2147483647)
                          setCart(
                            cart.map((v) =>
                              v.id === i.id ? { ...v, quantity: n } : v,
                            ),
                          );
                      }}
                    />,
                    amount(i.price * i.quantity),
                    <button
                      onClick={() => setCart(cart.filter((v) => v.id !== i.id))}
                    >
                      Remove
                    </button>,
                  ],
                }))}
              />
              <div className="checkout">
                <strong>Estimated total {amount(total)}</strong>
                <button className="primary" onClick={() => setCheckout(true)}>
                  Checkout
                </button>
              </div>
            </>
          )}
        </section>
      )}
      <section className="panel">
        <h2>Order history</h2>
        <State query={q} empty={!rows.length} message="No orders on this page.">
          <Table
            heads={["Order", "Placed", "Status", "Total"]}
            rows={rows.map((o) => ({
              key: o.id,
              cells: [
                <button className="text" onClick={() => setDetail(o.id)}>
                  #{o.id}
                </button>,
                dateTime(o.created_at),
                o.status,
                amount(o.total_amount),
              ],
            }))}
          />
        </State>
        <Pager
          page={page}
          setPage={setPage}
          next={page < (q.data?.pagination.totalPages || 0)}
        />
      </section>
      {checkout && (
        <ActionForm
          title="Confirm checkout"
          close={() => setCheckout(false)}
          submitLabel="Place order"
          onSubmit={async () => {
            const body = {
              items: cart.map((i) => ({
                productId: String(i.id),
                quantity: i.quantity,
              })),
            };
            const signature = JSON.stringify(body);
            if (checkoutRequest.current?.signature !== signature) {
              checkoutRequest.current = { signature, key: crypto.randomUUID() };
            }
            const { order } = await write(
              "/orders",
              "POST",
              body,
              checkoutRequest.current.key,
            );
            checkoutRequest.current = null;
            setCart([]);
            setPage(1);
            setDetail(order.id);
          }}
        >
          <p>
            Place this order for {cart.reduce((n, i) => n + i.quantity, 0)}{" "}
            units? Final pricing and stock are confirmed by the server.
          </p>
        </ActionForm>
      )}
      {detail && (
        <RecordDetails
          title={"Order #" + detail}
          close={() => setDetail(null)}
          path={"/orders/" + detail}
        >
          {({ order }) => (
            <>
              <p>
                {dateTime(order.created_at)} · {order.status}
              </p>
              <Table
                heads={["Product", "Qty", "Amount"]}
                rows={order.items.map((i) => ({
                  key: i.id,
                  cells: [i.product_name, i.quantity, amount(i.line_total)],
                }))}
              />
              <p>
                <strong>Order total {amount(order.total_amount)}</strong>
              </p>
              <Receipt orderId={detail} />
            </>
          )}
        </RecordDetails>
      )}
    </>
  );
}
