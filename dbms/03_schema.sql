-- ============================================================================
-- 03_schema.sql
-- Consolidated PostgreSQL Schema generated from project migrations
-- ============================================================================

-- 1. Categories
CREATE TABLE categories (
    id BIGSERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 2. Users
CREATE TABLE users (
    id BIGSERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    email VARCHAR(255) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(20) NOT NULL DEFAULT 'customer',
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 3. Products (includes low_stock_threshold from migration 1794030177261)
CREATE TABLE products (
    id BIGSERIAL PRIMARY KEY,
    category_id BIGINT NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
    name VARCHAR(200) NOT NULL,
    description TEXT,
    sku VARCHAR(100) NOT NULL UNIQUE,
    price NUMERIC(10, 2) NOT NULL,
    low_stock_threshold INTEGER DEFAULT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT products_low_stock_threshold_non_negative
        CHECK (low_stock_threshold IS NULL OR low_stock_threshold >= 0)
);

-- 4. Inventory (1-to-1 with products)
CREATE TABLE inventory (
    id BIGSERIAL PRIMARY KEY,
    product_id BIGINT NOT NULL UNIQUE REFERENCES products(id) ON DELETE RESTRICT,
    quantity INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 5. Suppliers & Supplier-Product Junction
CREATE TABLE suppliers (
    id BIGSERIAL PRIMARY KEY,
    name VARCHAR(200) NOT NULL,
    contact_name VARCHAR(100),
    email VARCHAR(255),
    phone VARCHAR(30),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT suppliers_name_not_empty CHECK (BTRIM(name) <> ''),
    CONSTRAINT suppliers_contact_required CHECK (
        (email IS NOT NULL AND BTRIM(email) <> '') OR
        (phone IS NOT NULL AND BTRIM(phone) <> '')
    )
);

CREATE TABLE supplier_products (
    supplier_id BIGINT NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
    product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
    CONSTRAINT supplier_products_pkey PRIMARY KEY (supplier_id, product_id)
);

CREATE INDEX supplier_products_product_id_idx
    ON supplier_products (product_id);

-- Trigger Function & Trigger: Prevent associating products with inactive suppliers
CREATE OR REPLACE FUNCTION check_supplier_is_active()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    supplier_active BOOLEAN;
BEGIN
    SELECT is_active
    INTO supplier_active
    FROM suppliers
    WHERE id = NEW.supplier_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Supplier does not exist'
            USING ERRCODE = '23503';
    END IF;

    IF supplier_active = FALSE THEN
        RAISE EXCEPTION 'Cannot associate a product with an inactive supplier'
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER prevent_inactive_supplier_association
    BEFORE INSERT OR UPDATE OF supplier_id, product_id
    ON supplier_products
    FOR EACH ROW
    EXECUTE FUNCTION check_supplier_is_active();

-- 6. Orders
CREATE TABLE orders (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    status VARCHAR(20) NOT NULL DEFAULT 'placed',
    total_amount NUMERIC(22, 2) NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT orders_total_amount_nonnegative CHECK (total_amount >= 0),
    CONSTRAINT orders_status_check CHECK (status IN ('placed', 'processing', 'completed', 'cancelled'))
);

CREATE INDEX idx_orders_user_created
    ON orders (user_id, created_at);

-- 7. Order Items
CREATE TABLE order_items (
    id BIGSERIAL PRIMARY KEY,
    order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
    product_name VARCHAR(200) NOT NULL,
    sku VARCHAR(100),
    unit_price NUMERIC(10, 2) NOT NULL,
    quantity INTEGER NOT NULL,
    line_total NUMERIC(20, 2) GENERATED ALWAYS AS (unit_price * quantity) STORED,
    CONSTRAINT order_items_quantity_positive CHECK (quantity > 0),
    CONSTRAINT order_items_price_nonnegative CHECK (unit_price >= 0),
    CONSTRAINT order_items_unique_product UNIQUE (order_id, product_id)
);

CREATE INDEX idx_order_items_product
    ON order_items (product_id);

-- 8. Inventory Transactions (includes order_id FK & check from migration 1794100000000)
CREATE TABLE inventory_transactions (
    id BIGSERIAL PRIMARY KEY,
    product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
    performed_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
    order_id BIGINT,
    transaction_type VARCHAR(10) NOT NULL CHECK (transaction_type IN ('increase', 'decrease')),
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    quantity_before INTEGER NOT NULL CHECK (quantity_before >= 0),
    quantity_after INTEGER NOT NULL CHECK (quantity_after >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT valid_transaction_quantity CHECK (
        (
            transaction_type = 'increase'
            AND quantity_after::BIGINT = quantity_before::BIGINT + quantity::BIGINT
        )
        OR
        (
            transaction_type = 'decrease'
            AND quantity_after::BIGINT = quantity_before::BIGINT - quantity::BIGINT
        )
    ),
    CONSTRAINT fk_inventory_transactions_order
        FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE RESTRICT,
    CONSTRAINT inventory_order_decrease_only
        CHECK (order_id IS NULL OR transaction_type = 'decrease')
);

CREATE INDEX idx_inventory_transactions_product_created
    ON inventory_transactions (product_id, created_at DESC);

CREATE INDEX idx_inventory_transactions_order
    ON inventory_transactions (order_id);

-- 9. Order Outbox (Transactional Outbox Pattern)
CREATE TABLE order_outbox (
    id BIGSERIAL PRIMARY KEY,
    event_type VARCHAR(80) NOT NULL,
    order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    payload JSONB NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    available_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    locked_until TIMESTAMPTZ,
    claim_token UUID,
    last_error TEXT,
    dispatched_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT order_outbox_status_check CHECK (status IN ('pending', 'processing', 'dispatched')),
    CONSTRAINT order_outbox_attempts_nonnegative CHECK (attempts >= 0),
    CONSTRAINT order_outbox_unique_event_per_order UNIQUE (event_type, order_id)
);

CREATE INDEX idx_order_outbox_pending
    ON order_outbox (status, available_at, id)
    WHERE status = 'pending';

CREATE INDEX idx_order_outbox_expired_leases
    ON order_outbox (locked_until)
    WHERE status = 'processing';

-- 10. Receipts (1-to-1 with orders)
CREATE TABLE receipts (
    id BIGSERIAL PRIMARY KEY,
    order_id BIGINT NOT NULL UNIQUE REFERENCES orders(id) ON DELETE RESTRICT,
    receipt_number VARCHAR(40) NOT NULL UNIQUE,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    total_amount NUMERIC(22, 2) NOT NULL,
    items JSONB NOT NULL,
    issued_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT receipts_total_nonnegative CHECK (total_amount >= 0),
    CONSTRAINT receipts_items_array_check CHECK (jsonb_typeof(items) = 'array')
);