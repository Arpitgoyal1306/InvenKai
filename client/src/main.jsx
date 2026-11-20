import React, { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  BrowserRouter,
  Routes,
  Route,
  Navigate,
  NavLink,
  Link,
  useLocation,
  useNavigate,
} from "react-router-dom";
import {
  QueryClient,
  QueryClientProvider,
  useQueryClient,
} from "@tanstack/react-query";
import {
  Activity,
  Boxes,
  ChartNoAxesCombined,
  CircleUserRound,
  Eye,
  EyeOff,
  LayoutGrid,
  LogOut,
  Mail,
  Package,
  ShoppingBasket,
  Truck,
  UserRound,
  LockKeyhole,
} from "lucide-react";
import "@fontsource-variable/dm-sans";
import "@fontsource/space-mono/400.css";
import { api, base, tokenKey, useData } from "./api";
import { Brand, State } from "./ui";
import {
  MarketShell,
  Explore,
  Storefront,
  Purchases,
  CartPage,
} from "./Market";
import { Owner } from "./Owner";
import Warehouse from "./Warehouse";
import { Overview, Products, Inventory, Suppliers, Orders } from "./Workspace";
import { Operations } from "./Operations";
import "./style.css";
import "./market.css";
import { AccountSettings } from "./Account";

function Auth({ register, login, landing }) {
  const location = useLocation();
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [show, setShow] = useState(false);
  async function submit(e) {
    e.preventDefault();
    const fields = Object.fromEntries(new FormData(e.currentTarget));
    setBusy(true);
    setError("");
    try {
      if (register)
        await api("/auth/register", {
          method: "POST",
          body: fields,
          publicRoute: true,
        });
      const result = await api("/auth/login", {
        method: "POST",
        body: { email: fields.email, password: fields.password },
        publicRoute: true,
      });
      login(result);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="auth-shell">
      <section className="auth-art">
        <Brand />
        <div className="hero-copy">
          <h1>
            Inventory
            <br />
            <em>workspace.</em>
          </h1>
          <p>Stock, suppliers, and orders in one place.</p>
        </div>
        <div className="art-frame">
          <Warehouse />
        </div>
        <div className="art-footer">
          <Boxes size={18} /> Inventory &amp; order management
        </div>
      </section>
      <section className="auth-content">
        <div className="auth-box">
          {landing ? (
            <>
              <h2>Welcome to InvenKai</h2>
              <p className="intro">Choose how you’d like to get started.</p>
              <Link className="entry-choice" to="/explore">
                <img src="/images/sample-shops/bakery.jpg" alt="" />
                <span>
                  <strong>Shop as a buyer</strong>
                  <small>
                    Explore stores, order products and track pickups.
                  </small>
                </span>
                <b>→</b>
              </Link>
              <Link className="entry-choice" to="/owner">
                <img src="/images/sample-shops/roaster.jpg" alt="" />
                <span>
                  <strong>Manage my store</strong>
                  <small>
                    Build your storefront and fulfill incoming orders.
                  </small>
                </span>
                <b>→</b>
              </Link>
              <p className="entry-signin">
                Returning to InvenKai? <Link to="/login">Sign in</Link>
              </p>
            </>
          ) : (
            <>
              <div className="tabs auth-tabs">
                <Link
                  className={!register ? "selected" : ""}
                  to={"/login" + location.search}
                >
                  Sign in
                </Link>
                <Link
                  className={register ? "selected" : ""}
                  to={"/register" + location.search}
                >
                  Create account
                </Link>
              </div>
              <h2>{register ? "Create your account" : "Welcome back"}</h2>
              <p className="intro">
                {register
                  ? "Register to browse products and place orders."
                  : "Sign in to your InvenKai workspace."}
              </p>
              <form onSubmit={submit}>
                <fieldset disabled={busy}>
                  {register && (
                    <label>
                      Full name
                      <div className="input-icon">
                        <UserRound />
                        <input
                          required
                          name="name"
                          autoComplete="name"
                          placeholder="Your name"
                          maxLength="100"
                        />
                      </div>
                    </label>
                  )}
                  <label>
                    Email address
                    <div className="input-icon">
                      <Mail />
                      <input
                        type="email"
                        name="email"
                        required
                        autoComplete="email"
                        placeholder="you@example.com"
                      />
                    </div>
                  </label>
                  <label>
                    Password
                    <div className="input-icon">
                      <LockKeyhole />
                      <input
                        type={show ? "text" : "password"}
                        name="password"
                        required
                        minLength={register ? 8 : 1}
                        autoComplete={
                          register ? "new-password" : "current-password"
                        }
                        placeholder={
                          register
                            ? "At least 8 characters"
                            : "Enter your password"
                        }
                      />
                      <button
                        type="button"
                        aria-label={show ? "Hide password" : "Show password"}
                        onClick={() => setShow(!show)}
                      >
                        {show ? <EyeOff /> : <Eye />}
                      </button>
                    </div>
                  </label>
                  {error && (
                    <p className="error" role="alert">
                      {error}
                    </p>
                  )}
                  <button className="primary wide">
                    {busy
                      ? "Please wait…"
                      : register
                        ? "Create account"
                        : "Sign in"}
                  </button>
                </fieldset>
              </form>
              <a
                className="google-sign-in"
                href={(import.meta.env.PROD ? "/api" : base) + "/auth/google"}
                onClick={() => {
                  sessionStorage.setItem(
                    "invenkai.google.next",
                    location.search,
                  );
                }}
              >
                Continue with Google
              </a>
            </>
          )}
        </div>
      </section>
    </main>
  );
}

function GoogleCallback({ login }) {
  const { search } = useLocation();
  const navigate = useNavigate();
  const [error, setError] = useState("");
  useEffect(() => {
    const params = new URLSearchParams(search);
    const code = params.get("code");
    const state = params.get("state");
    if (!code || !state) {
      navigate(
        "/login" + (sessionStorage.getItem("invenkai.google.next") || ""),
        { replace: true },
      );
      return;
    }
    const controller = new AbortController();
    api("/auth/google/callback", {
      method: "POST",
      body: { code, state },
      publicRoute: true,
      credentials: "include",
      sameOrigin: import.meta.env.PROD,
      signal: controller.signal,
    })
      .then((result) => {
        const next = sessionStorage.getItem("invenkai.google.next") || "";
        sessionStorage.removeItem("invenkai.google.next");
        login(result);
        navigate("/login" + next, { replace: true });
      })
      .catch((error) => {
        if (!controller.signal.aborted) setError(error.message);
      });
    return () => controller.abort();
  }, [search, navigate, login]);

  return (
    <main className="session-state">
      <Brand />
      {error ? (
        <>
          <p role="alert">{error}</p>
          <Link
            replace
            to={
              "/login" + (sessionStorage.getItem("invenkai.google.next") || "")
            }
          >
            Back to sign in
          </Link>
        </>
      ) : (
        <p role="status">Completing Google sign-in…</p>
      )}
    </main>
  );
}

function useLive(staff) {
  const client = useQueryClient();
  const [status, setStatus] = useState("Connecting");
  useEffect(() => {
    if (!staff) return;
    let stopped = false,
      socket,
      timer,
      attempt = 0;
    const controller = new AbortController();
    function reconnect() {
      if (stopped) return;
      setStatus("Reconnecting");
      timer = setTimeout(
        connect,
        Math.min(30000, 1000 * 2 ** Math.min(attempt++, 5)),
      );
    }
    async function connect() {
      try {
        const { ticket } = await api("/auth/ws-ticket", {
          method: "POST",
          signal: controller.signal,
        });
        if (stopped) return;
        const url = new URL(base, location.origin);
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        url.pathname = "/ws";
        url.search = "";
        url.searchParams.set("ticket", ticket);
        socket = new WebSocket(url);
        socket.onopen = () => {
          if (stopped) return;
          attempt = 0;
          setStatus("Live");
          client.invalidateQueries();
        };
        socket.onmessage = (e) => {
          let event;
          try {
            event = JSON.parse(e.data);
          } catch {
            return;
          }
          if (event.type === "inventory.updated")
            client.invalidateQueries({
              predicate: (q) =>
                /^\/(inventory|reports)(\/|\?)/.test(q.queryKey[0]),
            });
        };
        socket.onclose = reconnect;
      } catch {
        reconnect();
      }
    }
    connect();
    return () => {
      stopped = true;
      controller.abort();
      clearTimeout(timer);
      if (socket) {
        socket.onclose = null;
        socket.close();
      }
    };
  }, [client, staff]);
  return status;
}
function Workspace({ user, logout }) {
  const cartKey = "invenkai.cart." + user.id;
  const [cart, setCart] = useState(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(cartKey) || "[]");
      return Array.isArray(saved)
        ? saved.filter(
            (item) =>
              item?.id && Number.isInteger(item.quantity) && item.quantity > 0,
          )
        : [];
    } catch {
      return [];
    }
  });
  useEffect(() => {
    sessionStorage.setItem(cartKey, JSON.stringify(cart));
  }, [cart, cartKey]);
  const staff = ["admin", "inventory_manager"].includes(user.role),
    admin = user.role === "admin",
    canOrder = admin || user.role === "customer";
  const live = useLive(staff),
    location = useLocation();
  const links = [
    ...(staff ? [["/overview", "Overview", LayoutGrid]] : []),
    ["/products", "Products", Package],
    ...(staff
      ? [
          ["/inventory", "Inventory", Boxes],
          ["/suppliers", "Suppliers", Truck],
          ["/reports", "Reports", ChartNoAxesCombined],
        ]
      : []),
    ["/orders", "My orders", ShoppingBasket],
    ...(admin ? [["/operations", "Receipt recovery", Activity]] : []),
  ];
  const home = staff ? "/overview" : "/products";
  const title = links.find(([path]) => path === location.pathname)?.[1];
  function addToCart(p) {
    setCart((items) =>
      items.some((i) => i.id === p.id)
        ? items.map((i) =>
            i.id === p.id ? { ...i, quantity: i.quantity + 1 } : i,
          )
        : [...items, { ...p, quantity: 1 }],
    );
  }
  useEffect(() => {
    document.title = (title || "Workspace") + " · InvenKai";
  }, [title]);
  return (
    <div className="workspace">
      <aside>
        <Brand />
        <nav aria-label="Workspace">
          <Link to="/explore">
            <ShoppingBasket size={19} />
            Explore stores
          </Link>
          {links.map(([to, name, Icon]) => (
            <NavLink key={to} to={to}>
              <Icon size={19} />
              {name}
              {to === "/orders" && cart.length > 0 && (
                <span className="count">{cart.length}</span>
              )}
            </NavLink>
          ))}
        </nav>
        <div className="identity">
          <CircleUserRound />
          <div>
            <b>{user.name || "My account"}</b>
            <small>{user.role.replace("_", " ")}</small>
          </div>
          <button
            title="Sign out"
            aria-label="Sign out"
            onClick={() => {
              sessionStorage.removeItem(cartKey);
              logout();
            }}
          >
            <LogOut size={18} />
          </button>
        </div>
      </aside>
      <main className="desk">
        <header>
          <span>
            <ChartNoAxesCombined size={17} /> Workspace <b>/</b>{" "}
            {title || "Dashboard"}
          </span>
          {staff && (
            <span className="live">
              <Activity size={15} />
              {live}
            </span>
          )}
        </header>
        <div className="page">
          <Routes>
            {staff && <Route path="/overview" element={<Overview />} />}
            {staff && <Route path="/reports" element={<Overview reports />} />}
            {admin && <Route path="/operations" element={<Operations />} />}
            <Route
              path="/products"
              element={
                <Products
                  staff={staff}
                  admin={admin}
                  canOrder={canOrder}
                  addToCart={addToCart}
                />
              }
            />
            {staff && <Route path="/inventory" element={<Inventory />} />}{" "}
            {staff && (
              <Route path="/suppliers" element={<Suppliers admin={admin} />} />
            )}
            <Route
              path="/orders"
              element={
                <Orders cart={cart} setCart={setCart} canOrder={canOrder} />
              }
            />
            <Route path="*" element={<Navigate replace to={home} />} />
          </Routes>
        </div>
      </main>
    </div>
  );
}
function AccountHome() {
  const owner = useData("/market/owner");
  return (
    <State query={owner}>
      <Navigate replace to={owner.data?.store ? "/owner" : "/explore"} />
    </State>
  );
}
function App() {
  const location = useLocation();
  const [user, setUser] = useState(null),
    [checking, setChecking] = useState(
      Boolean(sessionStorage.getItem(tokenKey)),
    ),
    [failure, setFailure] = useState(""),
    [retry, setRetry] = useState(0);
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: false, staleTime: 15000 } },
      }),
  );
  function logout() {
    sessionStorage.removeItem(tokenKey);
    client.clear();
    setUser(null);
    setFailure("");
    setChecking(false);
    document.title = "InvenKai · Inventory workspace";
  }
  useEffect(() => {
    window.addEventListener("session-expired", logout);
    return () => window.removeEventListener("session-expired", logout);
  }, [client]);
  useEffect(() => {
    if (!sessionStorage.getItem(tokenKey)) return;
    const controller = new AbortController();
    setChecking(true);
    setFailure("");
    api("/auth/profile", { signal: controller.signal })
      .then(({ user }) => setUser(user))
      .catch((err) => {
        if (!controller.signal.aborted && err.status !== 401)
          setFailure(err.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setChecking(false);
      });
    return () => controller.abort();
  }, [retry]);
  useEffect(() => {
    if (!user) return;
    const payload = sessionStorage.getItem(tokenKey)?.split(".")[1];
    if (!payload) return;
    const { exp } = JSON.parse(
      atob(payload.replace(/-/g, "+").replace(/_/g, "/")),
    );
    const timer = setTimeout(logout, Math.max(0, exp * 1000 - Date.now()));
    return () => clearTimeout(timer);
  }, [user]);
  const login = useCallback(
    ({ token, user }) => {
      sessionStorage.removeItem("invenkai.cart." + user.id);
      sessionStorage.setItem(tokenKey, token);
      client.clear();
      setUser(user);
    },
    [client],
  );
  if (checking || failure)
    return (
      <main className="session-state">
        <Brand />
        {checking ? (
          <p role="status">Opening workspace…</p>
        ) : (
          <>
            <p role="alert">{failure}</p>
            <button onClick={() => setRetry((n) => n + 1)}>Retry</button>
            <button onClick={logout}>Sign out</button>
          </>
        )}
      </main>
    );
  const next = new URLSearchParams(location.search).get("next");
  const home = /^\/(?:owner|buyer|s|explore|account|cart)(?:[/?]|$)/.test(
    next || "",
  )
    ? next
    : user?.role === "admin" || user?.role === "inventory_manager"
      ? "/overview"
      : "/account";
  const guard = (element) =>
    user ? (
      element
    ) : (
      <Navigate
        replace
        to={
          "/login?next=" +
          encodeURIComponent(location.pathname + location.search)
        }
      />
    );
  const shell = (element) => (
    <MarketShell
      user={user}
      logout={() => {
        sessionStorage.removeItem("invenkai.market.cart");
        logout();
      }}
    >
      {element}
    </MarketShell>
  );
  return (
    <QueryClientProvider client={client}>
      <Routes>
        <Route path="/home" element={<GoogleCallback login={login} />} />
        <Route path="/" element={<Auth landing />} />
        {["login", "register"].map((path) => (
          <Route
            key={path}
            path={path}
            element={
              user ? (
                <Navigate replace to={home} />
              ) : (
                <Auth key={path} register={path === "register"} login={login} />
              )
            }
          />
        ))}
        <Route
          path="/account/settings"
          element={guard(
            shell(
              <AccountSettings
                onSaved={(profile) => {
                  client.setQueryData(["/auth/profile"], { user: profile });
                  setUser(profile);
                }}
              />,
            ),
          )}
        />
        <Route path="/cart" element={shell(<CartPage user={user} />)} />
        <Route path="/account" element={guard(<AccountHome />)} />
        <Route path="/explore" element={shell(<Explore />)} />
        <Route path="/s/:slug" element={shell(<Storefront user={user} />)} />
        <Route path="/buyer/orders" element={guard(shell(<Purchases />))} />
        <Route path="/owner/*" element={guard(shell(<Owner />))} />
        <Route
          path="*"
          element={
            user && ["admin", "inventory_manager"].includes(user.role) ? (
              <Workspace user={user} logout={logout} />
            ) : (
              <Navigate replace to="/" />
            )
          }
        />
      </Routes>
    </QueryClientProvider>
  );
}

createRoot(document.getElementById("root")).render(
  <BrowserRouter>
    <App />
  </BrowserRouter>,
);
