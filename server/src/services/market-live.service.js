// One PostgreSQL listener per API process. Browsers receive only a refresh signal.
const { Client } = require("pg");
const pool = require("../config/database");
const streams = new Map();
let listener;
let ready = false;

function listenerConnectionString() {
  if (process.env.NODE_ENV !== "test" && process.env.MARKET_LISTEN_DATABASE_URL)
    return process.env.MARKET_LISTEN_DATABASE_URL;

  const connection = new URL(pool.options.connectionString);
  // Neon transaction pooling cannot keep a session subscribed to LISTEN.
  if (connection.hostname.endsWith(".neon.tech"))
    connection.hostname = connection.hostname.replace("-pooler.", ".");
  return connection.href;
}

function disconnect(client) {
  if (listener !== client) return;
  listener = null;
  ready = false;
  for (const response of streams.keys()) response.end();
  streams.clear();
  client.end().catch(() => {});
}
function attach(req, res) {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-store",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();
  streams.set(res, req.user?.id?.toString() || null);
  const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 20000);
  res.on("close", () => {
    clearInterval(heartbeat);
    streams.delete(res);
    if (!streams.size && listener) disconnect(listener);
  });
  if (listener) {
    if (ready) res.write("data: refresh\n\n");
    return;
  }
  const client = new Client({
    connectionString: listenerConnectionString(),
  });
  listener = client;
  client.on("error", () => disconnect(client));
  client.on("end", () => disconnect(client));
  client.on("notification", (msg) => {
    let change;
    try {
      change = JSON.parse(msg.payload);
    } catch {
      return;
    }
    for (const [response, owner] of streams) {
      if (owner ? owner === change.owner : change.public === true) {
        if (!response.write("data: refresh\n\n")) response.end();
      }
    }
  });
  client
    .connect()
    .then(() => client.query("LISTEN market_inventory"))
    .then(() => {
      if (listener !== client) return;
      ready = true;
      for (const response of streams.keys())
        response.write("data: refresh\n\n");
    })
    .catch(() => disconnect(client));
}
function close() {
  if (listener) disconnect(listener);
}
module.exports = { attach, close };
