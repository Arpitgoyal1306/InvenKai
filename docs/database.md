# InvenKai database

The 19 migrations in [server/migrations](../server/migrations) are the source of truth for the PostgreSQL schema. They cover users and Google accounts, products and categories, warehouse and seller inventory, suppliers, orders, the receipt outbox, and receipts. The [onboarding guide](../DEVELOPER_ONBOARDING.md#d-apply-database-migrations) explains how to apply them and how to verify the historical timezone before migrating populated legacy orders.

| Records | Relationships |
|---|---|
| Users and stores | A user can own one marketplace store. Google subject and profile fields live on the user record. |
| Products and categories | A product belongs to one category. A null `products.store_id` identifies warehouse inventory. A store ID identifies seller inventory. Archival preserves references from past activity. |
| Inventory and history | Each product has one inventory row. Stock changes create transaction records with the product, actor, and optional order. Active stock views exclude archived products. History and stock movement retain past warehouse activity. |
| Suppliers | `supplier_products` links suppliers to products. Platform APIs scope links to warehouse products. |
| Orders and receipts | An order belongs to the buyer and optionally a store. Order items preserve product names and prices as purchased. Checkout retries are scoped by buyer and idempotency key. The outbox schedules receipt generation and each order has at most one stored receipt. |

The November 19 [backend audit](../BACKEND_FINAL_AUDIT.md) refers to an earlier directory layout and schema snapshot.
