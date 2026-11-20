import React, { useEffect, useRef, useState } from "react";
import {
  Link,
  NavLink,
  useParams,
  useLocation,
  useNavigate,
} from "react-router-dom";
import {
  keepPreviousData,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  Store,
  Bell,
  X,
  Package,
  UserRound,
  ArrowUpRight,
  ShoppingBag,
  Search,
  ArrowLeft,
  Settings,
  LogOut,
  ChevronRight,
  Compass,
  ReceiptText,
  Minus,
  Plus,
  Check,
  MapPin,
} from "lucide-react";
import { api, amount, dateTime, useData } from "./api";
import { Brand, State, Modal, Table } from "./ui";
import { useMarketLive } from "./useMarketLive";
import { addressFields } from "./Account";
import { isLowStock } from "./stockAlerts";
import { Receipt } from "./Operations";

export function useMarket(path, keepResults = false) {
  return useQuery({
    queryKey: [path],
    queryFn: ({ signal }) => api(path, { signal }),
    refetchInterval: 8000,
    placeholderData: keepResults ? keepPreviousData : undefined,
  });
}
export function useAction() {
  const client = useQueryClient(),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  async function act(fn, success) {
    setBusy(true);
    setMessage("");
    try {
      await fn();
      await client.invalidateQueries();
      setMessage(success || "");
      return true;
    } catch (e) {
      setMessage(e.message);
      await client.invalidateQueries();
      return false;
    } finally {
      setBusy(false);
    }
  }
  return { act, busy, message, setMessage };
}
const cartKey = "invenkai.market.cart";
function loadCart() {
  try {
    return JSON.parse(sessionStorage.getItem(cartKey)) || { items: [] };
  } catch {
    return { items: [] };
  }
}
function AccountAvatar({ url }) {
  const [broken, setBroken] = useState(false);
  return url && !broken ? (
    <img
      src={url}
      alt=""
      className="account-avatar"
      referrerPolicy="no-referrer"
      onError={() => setBroken(true)}
    />
  ) : (
    <UserRound size={18} />
  );
}

function StockAlerts() {
  const query = useMarket("/market/owner/products");
  const [notice, setNotice] = useState([]);
  const previous = useRef(null);
  const products = query.data?.products;
  const alerts = (products || []).filter(isLowStock);

  useEffect(() => {
    if (!products) return;
    const low = products.filter(isLowStock);
    const current = new Set(low.map((product) => product.id));
    const added = previous.current
      ? low.filter((product) => !previous.current.has(product.id))
      : [];
    previous.current = current;
    setNotice((existing) => [
      ...existing.filter((product) => current.has(product.id)),
      ...added,
    ]);
  }, [products]);

  return (
    <>
      <details className="account stock-alerts">
        <summary
          aria-label={`Stock alerts, ${alerts.length} ${alerts.length === 1 ? "product" : "products"}`}
        >
          <Bell size={19} />
          {!!alerts.length && (
            <span className="stock-alert-count">{alerts.length}</span>
          )}
        </summary>
        <div>
          <strong>Stock alerts</strong>
          {alerts.length ? (
            <ul>
              {alerts.map((p) => (
                <li key={p.id}>
                  <strong>{p.name}</strong>
                  <small>
                    {p.quantity
                      ? `${p.quantity} left in stock`
                      : "Out of stock"}
                  </small>
                </li>
              ))}
            </ul>
          ) : (
            <small>
              {query.isPending ? "Checking stock…" : "No low-stock products."}
            </small>
          )}
          {!!alerts.length && (
            <Link to="/owner/products?stock=low">Review stock</Link>
          )}
        </div>
      </details>
      {!!notice.length && (
        <div className="stock-toast">
          <p role="status">
            <strong>Stock alert</strong>
            <br />
            {notice.map((p) => p.name).join(", ")}{" "}
            {notice.length === 1 ? "needs" : "need"} restocking.
          </p>
          <button
            type="button"
            onClick={() => setNotice([])}
            aria-label="Dismiss stock alert"
          >
            <X size={17} />
          </button>
        </div>
      )}
    </>
  );
}

export function MarketShell({ user, logout, children }) {
  const loc = useLocation(),
    nav = useNavigate(),
    owner = loc.pathname.startsWith("/owner");
  useMarketLive(owner, user?.id);
  const [cart, setCart] = useState(loadCart);
  useEffect(() => {
    const refreshCart = () => setCart(loadCart());
    window.addEventListener("market-cart", refreshCart);
    return () => window.removeEventListener("market-cart", refreshCart);
  }, []);
  useEffect(() => {
    if (!loc.hash) window.scrollTo(0, 0);
  }, [loc.pathname, loc.hash]);
  const itemCount = cart.items.reduce(
    (count, item) => count + item.quantity,
    0,
  );
  const links = owner
    ? [
        ["/owner", "Overview"],
        ["/owner/products", "Products"],
        ["/owner/orders", "Orders"],
        ["/owner/settings", "Store settings"],
      ]
    : [
        ["/explore", "Explore stores", Compass],
        ["/buyer/orders", "My orders", ReceiptText],
      ];
  return (
    <div className={owner ? "market market-owner" : "market"}>
      <header className="market-head">
        <Link to="/" aria-label="InvenKai home">
          <Brand compact />
        </Link>
        <nav aria-label={owner ? "Store navigation" : "Shopping navigation"}>
          {links.map(([url, label, Icon]) => (
            <NavLink end key={url} to={url}>
              {Icon && <Icon size={17} aria-hidden="true" />}
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="market-head-actions">
          {owner && user && <StockAlerts key={user.id} />}
          {!owner && (
            <Link
              className="header-cart"
              to="/cart"
              aria-label={`View cart, ${itemCount} ${itemCount === 1 ? "item" : "items"}`}
            >
              <ShoppingBag size={19} />{" "}
              {itemCount > 0 && <span>{itemCount}</span>}
            </Link>
          )}
          <details key={loc.pathname} className="account">
            <summary aria-label="Account menu">
              <AccountAvatar key={user?.avatar_url} url={user?.avatar_url} />
            </summary>
            <div>
              {user && (
                <>
                  <section className="account-card">
                    <AccountAvatar
                      key={user.avatar_url}
                      url={user.avatar_url}
                    />
                    <div>
                      <strong>{user.name}</strong>
                      <small>{user.email}</small>
                    </div>
                  </section>
                  <Link to="/account/settings">
                    <Settings size={17} /> Account settings
                  </Link>
                </>
              )}
              <Link to={owner ? "/explore" : "/owner"}>
                {owner ? "Shop as a buyer" : "Manage my store"}
              </Link>
              {["admin", "inventory_manager"].includes(user?.role) && (
                <Link to="/overview">Platform workspace</Link>
              )}
              {user ? (
                <button
                  onClick={() => {
                    logout();
                    nav("/");
                  }}
                >
                  <LogOut size={17} /> Sign out
                </button>
              ) : (
                <Link to={"/login?next=" + encodeURIComponent(loc.pathname)}>
                  Sign in
                </Link>
              )}
            </div>
          </details>
        </div>
      </header>
      <main className="market-main">{children}</main>
    </div>
  );
}
export function Photo({ src, name, store = false }) {
  return src ? (
    <img
      loading="lazy"
      decoding="async"
      className="market-photo"
      src={src}
      alt={name}
    />
  ) : (
    <div
      aria-hidden="true"
      className={"market-placeholder " + (store ? "store-icon" : "")}
    >
      {store ? <Store size={40} /> : <Package size={38} />}
    </div>
  );
}
export function Filters({
  list,
  categories = [...new Set(list.map((x) => x.category))].sort(),
  search,
  setSearch,
  category,
  setCategory,
  label,
}) {
  return (
    <div className="market-filters">
      <div className="market-search">
        <Search size={18} aria-hidden="true" />
        <input
          type="search"
          maxLength={label === "Search stores" ? 120 : undefined}
          aria-label={label}
          placeholder={label}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      <select
        aria-label="Category"
        value={category}
        onChange={(e) => setCategory(e.target.value)}
      >
        <option value="">All categories</option>
        {categories.map((x) => (
          <option key={x}>{x}</option>
        ))}
      </select>
      {(search || category) && (
        <button
          onClick={() => {
            setSearch("");
            setCategory("");
          }}
        >
          Reset filters
        </button>
      )}
    </div>
  );
}
export function matches(x, search, category) {
  return (
    x.name.toLowerCase().includes(search.trim().toLowerCase()) &&
    (!category || x.category === category)
  );
}
export function Explore() {
  const [search, S] = useState("");
  const [cat, C] = useState("");
  const [term, setTerm] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setTerm(search.trim()), 200);
    return () => clearTimeout(timer);
  }, [search]);
  const params = new URLSearchParams();
  if (term) params.set("q", term);
  if (cat) params.set("category", cat);
  const q = useMarket(
    "/market/stores" + (params.size ? "?" + params : ""),
    true,
  );
  const shown = q.data?.stores || [];
  return (
    <>
      <section className="directory-hero">
        <div>
          <h1>Explore stores</h1>
          <p>
            Discover independent sellers. Shop their shelves and collect your
            order in store.
          </p>
        </div>
        <img
          src="/images/market-hall.jpg"
          alt="Sunlit neighborhood dining room with wooden tables"
        />
      </section>
      <div className="market-title directory-title">
        <h2>Store directory</h2>
        <small role="status">
          {q.isPlaceholderData
            ? "Updating results…"
            : q.data
              ? `${shown.length} ${shown.length === 1 ? "store" : "stores"}`
              : ""}
        </small>
      </div>
      <Filters
        categories={q.data?.categories || (cat ? [cat] : [])}
        search={search}
        setSearch={S}
        category={cat}
        setCategory={C}
        label="Search stores"
      />
      <State
        query={q}
        empty={!shown.length}
        message={
          term || cat
            ? "No stores match your search."
            : "No stores have published yet."
        }
      >
        <div className="market-grid store-directory">
          {shown.map((s) => (
            <article className="market-card" key={s.slug}>
              <Link
                className="store-cover-link"
                to={"/s/" + s.slug}
                aria-label={"Visit " + s.name}
              >
                <Photo src={s.cover || s.logo} name="" store />
              </Link>
              <div>
                <small>{s.category}</small>
                <h2>{s.name}</h2>
                <p>{s.description}</p>
                {s.products.length ? (
                  <ul
                    className="directory-products"
                    aria-label={"Products at " + s.name}
                  >
                    {s.products.map((product) => (
                      <li key={product.id}>
                        <strong>{product.name}</strong>
                        <span>
                          {amount(product.price)} ·{" "}
                          {product.quantity
                            ? product.quantity + " available"
                            : "Out of stock"}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p>No products currently listed.</p>
                )}
                <Link className="visit-store" to={"/s/" + s.slug}>
                  Visit store <ArrowUpRight size={15} />
                </Link>
              </div>
            </article>
          ))}
        </div>
      </State>
    </>
  );
}
export function Catalog({ store, products, onAdd, cartItems = [], children }) {
  const [search, S] = useState(""),
    [cat, C] = useState(""),
    shown = products.filter((p) => !p.archived && matches(p, search, cat));
  return (
    <>
      <section
        className="store-banner"
        style={
          store.cover
            ? {
                backgroundImage:
                  "linear-gradient(90deg,#182f2bf0,#182f2bb0),url(" +
                  store.cover +
                  ")",
              }
            : undefined
        }
      >
        {store.logo && <img src={store.logo} alt="Store logo" />}
        <small>{store.category}</small>
        <h1>{store.name}</h1>
        <p>{store.description}</p>
        <p>
          <b>Pickup</b> · {store.pickup}
        </p>
        <p>
          <b>Contact</b> · {store.contact}
        </p>
      </section>
      <div className={children ? "store-shopping" : ""}>
        <div className="store-products">
          <Filters
            list={products.filter((p) => !p.archived)}
            search={search}
            setSearch={S}
            category={cat}
            setCategory={C}
            label="Search products"
          />
          {!shown.length && <p className="state">No products to show.</p>}
          <div className="market-grid product-grid">
            {shown.map((p) => (
              <article className="market-card" key={p.id}>
                <Photo src={p.photo} name={p.name} />
                <div>
                  <small>{p.category}</small>
                  <h2>{p.name}</h2>
                  <p>{p.description}</p>
                  <div className="product-price">
                    <strong>{amount(p.price)}</strong>
                    <small
                      className={
                        p.quantity ? "stock-available" : "stock-unavailable"
                      }
                    >
                      {p.quantity ? p.quantity + " available" : "Out of stock"}
                    </small>
                  </div>
                  {onAdd && (
                    <button
                      disabled={
                        !p.quantity ||
                        cartItems.some(
                          (item) =>
                            item.id === p.id && item.quantity >= p.quantity,
                        )
                      }
                      onClick={() => onAdd(p)}
                    >
                      <ShoppingBag size={16} />{" "}
                      {cartItems.some(
                        (item) =>
                          item.id === p.id && item.quantity >= p.quantity,
                      )
                        ? "All available in cart"
                        : "Add to cart"}
                    </button>
                  )}
                </div>
              </article>
            ))}
          </div>
        </div>
        {children}
      </div>
    </>
  );
}
export function CartPage({ user }) {
  const cart = loadCart();
  if (!cart.items.length)
    return (
      <>
        <h1>Your cart</h1>
        <div className="market-panel empty-cart">
          <ShoppingBag size={30} />
          <h2>Your cart is empty</h2>
          <Link to="/explore">Explore stores</Link>
        </div>
      </>
    );
  return <Storefront user={user} cartSlug={cart.slug} />;
}
export function Storefront({ user, cartSlug }) {
  const { slug: routeSlug } = useParams();
  const slug = cartSlug || routeSlug;
  const profile = useData("/auth/profile", Boolean(user && cartSlug));
  const q = useMarket("/market/stores/" + encodeURIComponent(slug)),
    nav = useNavigate();
  const [cart, setCart] = useState(loadCart),
    [notice, N] = useState(""),
    [checkoutOpen, setCheckoutOpen] = useState(false),
    { act, busy, message, setMessage } = useAction();
  const checkoutRequest = useRef(null);
  const { hash } = useLocation();
  const loaded = Boolean(q.data);
  useEffect(() => {
    if (loaded && hash === "#cart")
      document.getElementById("cart")?.scrollIntoView();
  }, [hash, loaded, slug]);
  const own = cart.slug === slug ? cart.items : [],
    products = q.data?.products || [];
  function save(items) {
    const next = { slug, name: q.data.store.name, items };
    sessionStorage.setItem(cartKey, JSON.stringify(next));
    setCart(next);
    window.dispatchEvent(new Event("market-cart"));
  }
  function add(p) {
    if (
      cart.items.length &&
      cart.slug !== slug &&
      !window.confirm(
        "Replace your cart from " +
          cart.name +
          " with a cart from " +
          q.data.store.name +
          "?",
      )
    )
      return;
    const existing = own.find((i) => i.id === p.id);
    if (existing?.quantity >= p.quantity) {
      N("All available units are already in your cart.");
      return;
    }
    save(
      existing
        ? own.map((i) =>
            i === existing ? { ...i, quantity: i.quantity + 1 } : i,
          )
        : [...own, { id: p.id, name: p.name, price: p.price, quantity: 1 }],
    );
    N(p.name + " added to cart.");
  }
  async function checkout(event) {
    event.preventDefault();
    const buyerDetails = Object.fromEntries(new FormData(event.currentTarget));
    if (!user || busy) return;
    const body = {
      buyerDetails,
      items: own.map((item) => ({
        productId: item.id,
        quantity: item.quantity,
        price: item.price,
      })),
    };
    const signature = JSON.stringify([slug, body]);
    if (review && checkoutRequest.current?.signature !== signature) {
      setMessage("Review the current price and stock before placing a different order.");
      return;
    }
    if (checkoutRequest.current?.signature !== signature) {
      checkoutRequest.current = { signature, key: crypto.randomUUID() };
    }
    if (
      await act(() =>
        api("/market/stores/" + slug + "/orders", {
          method: "POST",
          body,
          idempotencyKey: checkoutRequest.current.key,
        }),
      )
    ) {
      sessionStorage.removeItem(cartKey);
      setCart({ items: [] });
      window.dispatchEvent(new Event("market-cart"));
      nav("/buyer/orders", { state: { orderPlaced: true } });
    }
  }
  const total = amount(
    own.reduce((sum, item) => sum + item.price * item.quantity, 0),
  );
  const review = own.some((i) => {
    const p = products.find((p) => p.id === i.id);
    return !p || p.quantity < i.quantity || Number(p.price) !== Number(i.price);
  });
  function openCheckout() {
    if (user) setCheckoutOpen(true);
    else nav("/login?next=" + encodeURIComponent("/cart"));
  }
  const cartPanel = q.data && (
    <aside id="cart" className="market-panel cart-panel" aria-label="Your cart">
      <h2>{cartSlug ? "Order items" : "Your cart"}</h2>
      <p className="sr-only" role="status">
        {notice}
      </p>
      {!own.length ? (
        <div className="cart-empty">
          <span className="cart-empty-icon">
            <ShoppingBag size={24} />
          </span>
          <strong>Your bag is empty</strong>
          <p>Add a product to start your order.</p>
        </div>
      ) : (
        <>
          <div className="cart-items">
            {own.map((i) => {
              const p = products.find((p) => p.id === i.id);
              return (
                <div className="market-row" key={i.id}>
                  <Photo src={p?.photo} name="" />
                  <div>
                    <b>{i.name}</b>
                    <strong className="cart-line-total">
                      {amount(Number(i.price) * i.quantity)}
                    </strong>
                    <small>
                      {amount(i.price)} each ·{" "}
                      {p ? p.quantity + " available" : "Unavailable"}
                    </small>
                    {p && Number(p.price) !== Number(i.price) && (
                      <button
                        onClick={() =>
                          save(
                            own.map((x) =>
                              x.id === i.id ? { ...x, price: p.price } : x,
                            ),
                          )
                        }
                      >
                        Accept updated price {amount(p.price)}
                      </button>
                    )}
                  </div>
                  <div className="cart-controls">
                    <button
                      type="button"
                      aria-label={"Decrease quantity for " + i.name}
                      disabled={i.quantity === 1}
                      onClick={() =>
                        save(
                          own.map((item) =>
                            item.id === i.id
                              ? { ...item, quantity: item.quantity - 1 }
                              : item,
                          ),
                        )
                      }
                    >
                      <Minus size={14} />
                    </button>
                    <b aria-label={"Quantity " + i.quantity}>{i.quantity}</b>
                    <button
                      type="button"
                      aria-label={"Increase quantity for " + i.name}
                      disabled={!p || i.quantity >= p.quantity}
                      onClick={() =>
                        save(
                          own.map((item) =>
                            item.id === i.id
                              ? { ...item, quantity: item.quantity + 1 }
                              : item,
                          ),
                        )
                      }
                    >
                      <Plus size={14} />
                    </button>
                    <button
                      type="button"
                      className="cart-remove"
                      onClick={() =>
                        save(own.filter((item) => item.id !== i.id))
                      }
                    >
                      Remove
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
          <div className="cart-summary">
            <h3>Order summary</h3>
            <div className="cart-subtotal">
              <span>Subtotal</span>
              <strong>{total}</strong>
            </div>
            <div className="cart-location">
              <MapPin size={17} />
              <p>
                <strong>Pay at pickup</strong>
                <br />
                {q.data.store.pickup}
              </p>
            </div>
            {review && (
              <p role="status">
                Review the price and available stock for the items above.
              </p>
            )}
            <button
              type="button"
              className="primary cart-continue"
              disabled={
                busy || review || Boolean(cartSlug && user && profile.isLoading)
              }
              onClick={cartSlug ? openCheckout : () => nav("/cart")}
            >
              {cartSlug
                ? user
                  ? "Continue to checkout"
                  : "Sign in to check out"
                : "Review cart"}{" "}
              <ChevronRight size={17} />
            </button>
          </div>
          {checkoutOpen && (
            <Modal
              title="Checkout"
              className="market-checkout"
              close={() => setCheckoutOpen(false)}
              busy={busy}
            >
              <div className="checkout-pickup">
                <MapPin size={18} />{" "}
                <span>
                  <b>Pay at pickup</b>
                  <br />
                  {q.data.store.pickup}
                </span>
              </div>
              <form className="checkout-form" onSubmit={checkout}>
                {user && (
                  <fieldset disabled={busy}>
                    <legend>Buyer details</legend>
                    <p>
                      Your contact details and address will be shared with this
                      store for this order. Collection is at the pickup location
                      above.
                    </p>
                    <div className="checkout-fields">
                      {[
                        ["name", "Full name", "name", 120],
                        ["phone", "Contact phone", "tel", 28],
                        ...addressFields,
                      ].map(([name, label, complete, max]) => (
                        <label key={name}>
                          {label}
                          <input
                            required
                            name={name}
                            autoComplete={complete}
                            maxLength={max}
                            type={name === "phone" ? "tel" : "text"}
                            defaultValue={
                              name === "name"
                                ? profile.data?.user.name || user.name
                                : name === "phone"
                                  ? profile.data?.user.phone || ""
                                  : profile.data?.user.pickup_address?.[name] ||
                                    ""
                            }
                          />
                        </label>
                      ))}
                    </div>
                  </fieldset>
                )}
                <p className="checkout-total">
                  Order total <strong>{total}</strong>
                </p>
                <button
                  className="primary"
                  disabled={busy || (review && !checkoutRequest.current)}
                >
                  {busy
                    ? "Placing order…"
                    : review && checkoutRequest.current
                      ? "Retry previous checkout"
                      : "Place pickup order"}
                </button>
                {review && (
                  <p role="alert">
                    {checkoutRequest.current
                      ? "Stock or price changed. You can retry the same checkout to check whether it already went through."
                      : "The cart changed. Close checkout to review current price and availability."}
                  </p>
                )}
                {message && (
                  <p className="checkout-error" role="alert">
                    {message}
                  </p>
                )}
              </form>
            </Modal>
          )}
        </>
      )}
    </aside>
  );
  if (cartSlug && q.error?.status === 404) {
    return (
      <>
        <h1>Your cart</h1>
        <section className="market-panel empty-cart">
          <h2>This store is unavailable</h2>
          <button
            onClick={() => {
              sessionStorage.removeItem(cartKey);
              window.dispatchEvent(new Event("market-cart"));
              nav("/explore");
            }}
          >
            Clear cart and explore stores
          </button>
        </section>
      </>
    );
  }
  return (
    <State query={q}>
      {q.data &&
        (cartSlug ? (
          <div className="cart-page">
            <Link className="back-to-stores" to={"/s/" + slug}>
              <ArrowLeft size={17} /> Back to {q.data.store.name}
            </Link>
            <h1>Your cart</h1>
            <p className="cart-store-name">{q.data.store.name}</p>
            {cartPanel}
          </div>
        ) : (
          <>
            <Link className="back-to-stores" to="/explore">
              <ArrowLeft size={17} /> Explore stores
            </Link>
            <Catalog
              store={q.data.store}
              products={products}
              onAdd={add}
              cartItems={own}
            >
              {cartPanel}
            </Catalog>
          </>
        ))}
    </State>
  );
}

export function OrderDetail({ order, owner, close }) {
  const path = owner ? "/market/owner/orders/" : "/orders/",
    q = useMarket(path + order.id),
    o = q.data?.order,
    { act, busy, message } = useAction();
  const orderItems = o && (
    <>
      <Table
        heads={["Item", "Quantity", "Price", "Total"]}
        rows={o.items.map((i, k) => ({
          key: k,
          cells: [
            i.product_name,
            i.quantity,
            amount(i.unit_price),
            amount(i.line_total),
          ],
        }))}
      />
      <h3>Total · {amount(o.total_amount)}</h3>
    </>
  );
  return (
    <Modal title={"Order #" + order.id} close={close} busy={busy}>
      <State query={q}>
        {o && (
          <>
            <p>
              {dateTime(o.created_at)} · {o.status}
            </p>
            {owner && (
              <p>
                <b>{o.buyer}</b> · {o.email}
              </p>
            )}
            <p>
              {order.store_name} · Pickup:{" "}
              {o.pickup_snapshot ||
                order.pickup_snapshot ||
                "See store details"}
            </p>
            {o.buyer_details && (
              <section className="checkout-contact">
                <h3>Buyer details</h3>
                <b>{o.buyer_details.name}</b>
                <p>{o.buyer_details.phone}</p>
                <p>
                  {[
                    o.buyer_details.address,
                    o.buyer_details.city,
                    o.buyer_details.region,
                    o.buyer_details.postalCode,
                    o.buyer_details.country,
                  ].join(", ")}
                </p>
              </section>
            )}
            {owner && orderItems}
            {owner ? (
              ["placed", "processing"].includes(o.status) && (
                <button
                  disabled={busy}
                  className="primary"
                  onClick={() =>
                    act(
                      () =>
                        api(path + o.id, {
                          method: "PATCH",
                          body: {
                            status:
                              o.status === "placed"
                                ? "processing"
                                : "completed",
                          },
                        }),
                      "Order updated.",
                    )
                  }
                >
                  {o.status === "placed"
                    ? "Start processing"
                    : "Mark completed"}
                </button>
              )
            ) : (
              <Receipt
                orderId={o.id}
                storeName={order.store_name}
                preview={orderItems}
              />
            )}
            <p role="status">{message}</p>
          </>
        )}
      </State>
    </Modal>
  );
}
export function Purchases() {
  const { state } = useLocation();
  const q = useMarket("/market/purchases"),
    orders = q.data?.orders || [],
    [selected, S] = useState(null);
  return (
    <>
      <h1>My orders</h1>
      {state?.orderPlaced && (
        <p className="order-success" role="status">
          <Check size={18} /> Order placed. Check the details for pickup
          information.
        </p>
      )}
      <State
        query={q}
        empty={!orders.length}
        message="Your orders will appear here after checkout."
      >
        {orders.map((o) => (
          <section key={o.id} className="market-panel market-row purchase-row">
            <div>
              <small>
                Order #{o.id} · {dateTime(o.created_at)}
              </small>
              <h2>{o.store_name}</h2>
              <p>
                <span className="order-status" data-status={o.status}>
                  {o.status}
                </span>{" "}
                <strong>{amount(o.total_amount)}</strong>
              </p>
            </div>
            {o.slug && <Link to={"/s/" + o.slug}>Visit store</Link>}
            <button onClick={() => S(o)}>Order details</button>
          </section>
        ))}
      </State>
      {selected && <OrderDetail order={selected} close={() => S(null)} />}
    </>
  );
}
