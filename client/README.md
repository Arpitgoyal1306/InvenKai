# InvenKai frontend

The React workspace uses the existing Express API and authenticated inventory WebSocket. Start the backend with its own PostgreSQL and Redis configuration. For the default local URLs set `CLIENT_URL=http://localhost:5173` in the backend environment.

From the `client/` directory:

```sh
npm ci
npm run dev
```

Open <http://localhost:5173>. Vite proxies `/api` and `/ws` to the server on port 5001. For separate hosting, copy `.env.example` to `.env.local`, set `VITE_API_URL` to the backend origin, such as `https://your-service.onrender.com`, and rebuild for production or restart the dev server. Staff WebSocket connections use the same host as the API. Only public configuration belongs in Vite environment variables.

New accounts receive the customer role. Customers can browse the catalog, check stock, and check out. Inventory managers can manage products, stock, and suppliers and view reports. Admins can also check out, delete eligible products, and deactivate suppliers. The backend enforces permissions on every request. Sign-in persists for the current browser tab until logout or token expiry.

Product creation lists existing categories from the category-stock report. Use **New category** in Products to create the first category in an empty database. Checkout uses server pricing and preserves the cart on a rejected order.

Run `npm run build` to create `client/dist`. The production Express server serves this bundle and handles browser routes from the same origin. For separate static hosting, rewrite application routes to `index.html`, configure the server's `CLIENT_URL`, and keep the client and API on the same site for the Google sign-in cookie.

Staff can create categories from Products, set or disable alert thresholds from Inventory, link products to a supplier, and filter movement history by product ID. Reports supports category filtering and UTC date ranges. In My orders, an order's receipt becomes downloadable when the worker finishes. Admins can inspect failed receipt jobs and request a retry from Receipt recovery.

For local receipt processing run `npm run dispatcher:orders` and `npm run worker:orders` in separate backend terminals using the same backend database and Redis configuration.

## Buyer and store owner routes

Apply the backend migrations before starting the marketplace. Review the historical timezone instructions before migrating an existing database with populated legacy orders. The marketplace migration preserves existing products and orders in the platform workspace.

The landing page offers buyer browsing at `/explore` and authenticated store setup at `/owner`. Each account can own one store. Store ownership comes from the authenticated user ID. A draft stays private until its owner adds an active product and publishes. The first publication permanently reserves the public link at `/s/:slug`. Store and product photos are resized in the browser and stored with their records.

Buyers collect and pay at pickup. A tab retains one store cart through refresh and sign-in. Checkout validates the quoted prices and locks stock in PostgreSQL. The owner advances fulfillment from placed to processing to completed. Buyer receipts use the existing outbox and receipt worker. Store screens receive server-sent refresh events after inventory changes commit in PostgreSQL. The browser reconnects after an interruption and also refreshes every eight seconds. Reverse proxies should disable buffering for the marketplace live routes. The existing staff WebSocket, supplier tools and platform reports remain in the platform workspace.

Checkout collects a buyer name, phone and postal address for the individual pickup order. Access is limited to the buyer and the receiving store. After migrating a local development database, run `node src/scripts/seed-sample-shops.js` from the `server/` directory to add the three photographed sample stores. Rerunning it preserves their inventory and existing orders.
