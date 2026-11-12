
# InvenKai Backend API Contracts

## 1. Scope

This document describes the currently implemented API endpoints in these five backend route modules:

- `backend/src/routes/auth.routes.js`
- `backend/src/routes/product.routes.js`
- `backend/src/routes/supplier.routes.js`
- `backend/src/routes/inventory.routes.js`
- `backend/src/routes/reports.routes.js`

The API base path is `/api`.

Only existing endpoints in these five modules are documented. No future endpoints or backend implementation changes are included.

All request and response examples use JSON. IDs, timestamps, and database-generated values are illustrative.

## 2. Authentication and Authorization

### Authentication mechanism

Protected endpoints require a JWT access token in the HTTP `Authorization` header:

```http
Authorization: Bearer <access_token>
```

The token is obtained from the login endpoint and expires after one hour.

### Common authentication errors

| HTTP status | Condition | Response |
|---|---|---|
| 401 | Authorization header or Bearer token is missing | `{"message":"Authentication token required"}` |
| 401 | Token is empty, malformed, invalid, expired, or has invalid required claims | `{"message":"Invalid or expired token"}` |

### Role-based authorization

The backend uses these roles:

- `admin`
- `inventory_manager`

| HTTP status | Condition | Response |
|---|---|---|
| 401 | Authentication is required but no authenticated user is available | `{"message":"Authentication required"}` |
| 403 | Authenticated user does not have an allowed role | `{"message":"You do not have permission to access this resource"}` |

An endpoint marked **Any authenticated role** accepts any valid authenticated role unless a specific role requirement is listed.

## 3. Authentication Endpoints

### 3.1 Register a user

**POST** `/api/auth/register`

- Authentication: Not required
- Required role: None

Request body:

```json
{
  "name": "Aarav Sharma",
  "email": "aarav@example.com",
  "password": "password123"
}
```

Validation:

- `name`: required, non-empty string.
- `email`: required, valid email address.
- `password`: required, string with at least 8 characters.
- Email is normalized before storage.

Success response — **201 Created**

```json
{
  "message": "User registered successfully",
  "user": {
    "id": 1,
    "name": "Aarav Sharma",
    "email": "aarav@example.com",
    "role": "inventory_manager",
    "created_at": "2026-11-12T10:00:00.000Z"
  }
}
```

Errors:

| HTTP status | Condition |
|---|---|
| 400 | Invalid or missing registration fields; response contains a `message` |
| 409 | Email is already registered |
| 500 | Unexpected server error: `{"message":"Internal server error"}` |

The password hash is not included in the returned user object.

### 3.2 Log in

**POST** `/api/auth/login`

- Authentication: Not required
- Required role: None

Request body:

```json
{
  "email": "aarav@example.com",
  "password": "password123"
}
```

Validation:

- `email`: required, valid email address.
- `password`: required, non-empty string.

Success response — **200 OK**

```json
{
  "message": "Login successful",
  "token": "<access_token>",
  "user": {
    "id": 1,
    "name": "Aarav Sharma",
    "email": "aarav@example.com",
    "role": "inventory_manager"
  }
}
```

Errors:

| HTTP status | Condition |
|---|---|
| 400 | Invalid or missing login fields |
| 401 | Invalid email or password |
| 500 | Unexpected server error: `{"message":"Internal server error"}` |

### 3.3 Get the authenticated user

**GET** `/api/auth/me`

- Authentication: Required
- Required role: Any authenticated role

Request body: None.

Success response — **200 OK**

```json
{
  "user": {
    "id": "1",
    "role": "inventory_manager"
  }
}
```

The user object contains the authenticated user's ID and role from the verified token.

Errors: Common authentication errors described in Section 2.



## 4. Product Endpoints

### 4.1 Create a product

**POST** `/api/products/`

- Authentication: Required
- Required role: `inventory_manager` or `admin`

Request body:

```json
{
  "category_id": 1,
  "name": "Wireless Mouse",
  "description": "Ergonomic wireless mouse",
  "sku": "MOUSE-001",
  "price": 799.99
}
```

Validation:

- `category_id`: required, positive integer.
- `name`: required, non-empty string, maximum 200 characters.
- `description`: optional string or `null`.
- `sku`: required, non-empty string, maximum 100 characters.
- `price`: required, finite, non-negative number, maximum 99,999,999.99, with at most two decimal places.

Success response — **201 Created**

```json
{
  "message": "Product created successfully",
  "product": {
    "id": 1,
    "category_id": 1,
    "name": "Wireless Mouse",
    "description": "Ergonomic wireless mouse",
    "sku": "MOUSE-001",
    "price": "799.99"
  }
}
```

The `product` object represents the persisted product row. Database-returned fields may include timestamps and other schema fields.

Errors:

| HTTP status | Condition |
|---|---|
| 400 | Invalid fields, missing required fields, invalid category, or validation failure |
| 409 | A product with this SKU already exists |
| 401 / 403 | Authentication or role requirement not met |
| 500 | `{"message":"Failed to create product"}` |

### 4.2 List products

**GET** `/api/products/`

- Authentication: Required
- Required role: Any authenticated role

Query parameters:

| Parameter | Required | Default | Description |
|---|---|---|---|
| `limit` | No | `10` | Number of products to return; integer from 1 to 100 |
| `offset` | No | `0` | Number of records to skip; integer greater than or equal to 0 |

Example:

`GET /api/products/?limit=10&offset=0`

Request body: None.

Success response — **200 OK**

```json
{
  "products": [
    {
      "id": 1,
      "category_id": 1,
      "name": "Wireless Mouse",
      "sku": "MOUSE-001",
      "price": "799.99"
    }
  ],
  "pagination": {
    "limit": 10,
    "offset": 0
  }
}
```

Errors:

| HTTP status | Condition |
|---|---|
| 400 | Invalid pagination values |
| 401 | Authentication required or token invalid |
| 500 | `{"message":"Failed to retrieve products"}` |

### 4.3 Get a product by ID

**GET** `/api/products/:id`

- Authentication: Required
- Required role: Any authenticated role

Path parameters:

| Parameter | Description |
|---|---|
| `id` | Positive integer product ID |

Request body: None.

Success response — **200 OK**

```json
{
  "product": {
    "id": 1,
    "category_id": 1,
    "name": "Wireless Mouse",
    "sku": "MOUSE-001",
    "price": "799.99"
  }
}
```

Errors:

| HTTP status | Condition |
|---|---|
| 400 | Product ID must be a positive integer |
| 404 | `{"message":"Product not found"}` |
| 401 | Authentication required or token invalid |
| 500 | `{"message":"Failed to retrieve product"}` |

### 4.4 Update a product

**PATCH** `/api/products/:id`

- Authentication: Required
- Required role: `inventory_manager` or `admin`

Path parameters:

| Parameter | Description |
|---|---|
| `id` | Positive integer product ID |

Supported request body fields: `category_id`, `name`, `description`, `sku`, `price`.

Example:

```json
{
  "name": "Wireless Mouse Pro",
  "price": 999.99
}
```

At least one supported field must be supplied. The supplied fields are validated against the product rules in Section 4.1.

Success response — **200 OK**

```json
{
  "message": "Product updated successfully",
  "product": {
    "id": 1,
    "category_id": 1,
    "name": "Wireless Mouse Pro",
    "sku": "MOUSE-001",
    "price": "999.99"
  }
}
```

Errors:

| HTTP status | Condition |
|---|---|
| 400 | Invalid ID, empty update, invalid fields, or validation failure |
| 404 | Product not found |
| 409 | Duplicate SKU |
| 401 / 403 | Authentication or role requirement not met |
| 500 | `{"message":"Failed to update product"}` |

### 4.5 Delete a product

**DELETE** `/api/products/:id`

- Authentication: Required
- Required role: `admin`

Path parameters:

| Parameter | Description |
|---|---|
| `id` | Positive integer product ID |

Request body: None.

Success response — **200 OK**

```json
{
  "message": "Product deleted successfully",
  "product": {
    "id": 1,
    "name": "Wireless Mouse",
    "sku": "MOUSE-001"
  }
}
```

Errors:

| HTTP status | Condition |
|---|---|
| 400 | Invalid product ID |
| 404 | Product not found |
| 409 | Product has associated inventory, transaction history, or supplier records |
| 401 / 403 | Authentication or role requirement not met |
| 500 | `{"message":"Failed to delete product"}` |

## 5. Supplier Endpoints

### 5.1 Create a supplier

**POST** `/api/suppliers/`

- Authentication: Required
- Required role: `inventory_manager` or `admin`

Request body:

```json
{
  "name": "ABC Supplies",
  "contact_name": "Rahul Kumar",
  "email": "contact@abcsupplies.com",
  "phone": "+91 9876543210"
}
```

Validation:

- `name`: required, non-empty string, maximum 200 characters.
- `contact_name`: optional string or `null`, maximum 100 characters.
- `email`: optional valid email or `null`, maximum 255 characters.
- `phone`: optional string or `null`, maximum 30 characters.
- At least one of `email` or `phone` must be provided.
- Phone numbers are validated for allowed characters and 7–15 digits.

Success response — **201 Created**

```json
{
  "message": "Supplier created successfully",
  "supplier": {
    "id": 1,
    "name": "ABC Supplies",
    "contact_name": "Rahul Kumar",
    "email": "contact@abcsupplies.com",
    "phone": "+91 9876543210",
    "is_active": true
  }
}
```

Errors:

| HTTP status | Condition |
|---|---|
| 400 | Missing or invalid supplier details |
| 401 / 403 | Authentication or role requirement not met |
| 500 | `{"message":"Failed to create supplier"}` |

### 5.2 List suppliers

**GET** `/api/suppliers/`

- Authentication: Required
- Required role: Any authenticated role

Query parameters:

| Parameter | Required | Default | Description |
|---|---|---|---|
| `limit` | No | `10` | Number of suppliers to return; integer from 1 to 100 |
| `offset` | No | `0` | Number of records to skip; integer greater than or equal to 0 |

Example:

`GET /api/suppliers/?limit=10&offset=0`

Request body: None.

Only active suppliers are included.

Success response — **200 OK**

```json
{
  "suppliers": [
    {
      "id": 1,
      "name": "ABC Supplies",
      "contact_name": "Rahul Kumar",
      "email": "contact@abcsupplies.com",
      "phone": "+91 9876543210",
      "is_active": true
    }
  ],
  "pagination": {
    "limit": 10,
    "offset": 0
  }
}
```

Errors:

| HTTP status | Condition |
|---|---|
| 400 | Invalid pagination values |
| 401 | Authentication required or token invalid |
| 500 | `{"message":"Failed to retrieve suppliers"}` |

### 5.3 Get a supplier by ID

**GET** `/api/suppliers/:id`

- Authentication: Required
- Required role: Any authenticated role

Path parameters:

| Parameter | Description |
|---|---|
| `id` | Positive integer supplier ID |

Request body: None.

Success response — **200 OK**

```json
{
  "supplier": {
    "id": 1,
    "name": "ABC Supplies",
    "contact_name": "Rahul Kumar",
    "email": "contact@abcsupplies.com",
    "phone": "+91 9876543210",
    "is_active": true
  }
}
```

Errors:

| HTTP status | Condition |
|---|---|
| 400 | `{"message":"Supplier ID must be a positive integer"}` |
| 404 | `{"message":"Supplier not found"}` |
| 401 | Authentication required or token invalid |
| 500 | `{"message":"Failed to retrieve supplier"}` |

### 5.4 Update a supplier

**PATCH** `/api/suppliers/:id`

- Authentication: Required
- Required role: `inventory_manager` or `admin`

Path parameters:

| Parameter | Description |
|---|---|
| `id` | Positive integer supplier ID |

Supported request body fields: `name`, `contact_name`, `email`, `phone`.

Example:

```json
{
  "contact_name": "Aman Verma",
  "phone": "+91 9876543211"
}
```

At least one field must be supplied. Unknown fields are rejected. The resulting supplier must still have at least one contact method (`email` or `phone`).

Success response — **200 OK**

```json
{
  "message": "Supplier updated successfully",
  "supplier": {
    "id": 1,
    "name": "ABC Supplies",
    "contact_name": "Aman Verma",
    "email": "contact@abcsupplies.com",
    "phone": "+91 9876543211",
    "is_active": true
  }
}
```

Errors:

| HTTP status | Condition |
|---|---|
| 400 | Invalid ID, empty update, unknown fields, or validation failure |
| 404 | Supplier not found |
| 401 / 403 | Authentication or role requirement not met |
| 500 | `{"message":"Failed to update supplier"}` |

### 5.5 Delete a supplier

**DELETE** `/api/suppliers/:id`

- Authentication: Required
- Required role: `admin`

Path parameters:

| Parameter | Description |
|---|---|
| `id` | Positive integer supplier ID |

Request body: None.

Deletion is implemented as a soft delete: the supplier is marked inactive rather than physically removed.

Success response — **200 OK**

```json
{
  "message": "Supplier deleted successfully",
  "supplier": {
    "id": 1,
    "name": "ABC Supplies",
    "is_active": false
  }
}
```

Errors:

| HTTP status | Condition |
|---|---|
| 400 | Supplier ID must be a positive integer |
| 404 | Supplier not found |
| 401 / 403 | Authentication or role requirement not met |
| 500 | `{"message":"Failed to delete supplier"}` |


## 6. Inventory Endpoints

### 6.1 Get inventory transaction history

**GET** `/api/inventory/history`

- Authentication: Required
- Required role: Any authenticated role

Query parameters:

| Parameter | Required | Default | Description |
|---|---|---|---|
| `productId` | No | — | Optional positive integer product ID filter |
| `limit` | No | `20` | Number of transactions; integer from 1 to 100 |
| `offset` | No | `0` | Number of records to skip; integer greater than or equal to 0 |

Example:

`GET /api/inventory/history?productId=1&limit=20&offset=0`

Request body: None.

Success response — **200 OK**

```json
{
  "transactions": [
    {
      "id": 1,
      "product_id": 1,
      "performed_by": 1,
      "transaction_type": "increase",
      "quantity": 10,
      "quantity_before": 5,
      "quantity_after": 15,
      "created_at": "2026-11-12T10:00:00.000Z"
    }
  ],
  "pagination": {
    "limit": 20,
    "offset": 0
  }
}
```

Errors:

| HTTP status | Condition |
|---|---|
| 400 | `{"message":"Invalid productId, limit, or offset"}` |
| 401 | Authentication required or token invalid |
| 500 | `{"message":"Failed to fetch inventory history"}` |

### 6.2 Get low-stock products

**GET** `/api/inventory/low-stock`

- Authentication: Required
- Required role: `inventory_manager` or `admin`

Request body: None. Query parameters: None.

Success response — **200 OK**

```json
{
  "count": 1,
  "products": [
    {
      "product_id": 1,
      "name": "Wireless Mouse",
      "sku": "MOUSE-001",
      "category_id": 1,
      "quantity": 3,
      "low_stock_threshold": 5
    }
  ]
}
```

Errors:

| HTTP status | Condition |
|---|---|
| 401 / 403 | Authentication or role requirement not met |
| 500 | `{"message":"Failed to fetch low-stock products"}` |

### 6.3 Get inventory for a product

**GET** `/api/inventory/:productId`

- Authentication: Required
- Required role: Any authenticated role

Path parameters:

| Parameter | Description |
|---|---|
| `productId` | Positive integer product ID |

Request body: None.

Success response — **200 OK**

```json
{
  "inventory": {
    "product_id": 1,
    "quantity": 15,
    "created_at": "2026-11-12T10:00:00.000Z",
    "updated_at": "2026-11-12T10:00:00.000Z"
  }
}
```

Errors:

| HTTP status | Condition |
|---|---|
| 400 | `{"message":"Product ID must be a positive integer"}` |
| 404 | `{"message":"Inventory not found"}` |
| 401 | Authentication required or token invalid |
| 500 | `{"message":"Failed to retrieve inventory"}` |

### 6.4 Decrease stock

**PATCH** `/api/inventory/:productId/decrease`

- Authentication: Required
- Required role: `inventory_manager` or `admin`

Path parameters:

| Parameter | Description |
|---|---|
| `productId` | Positive integer product ID |

Request body:

```json
{
  "quantity": 2
}
```

`quantity` must be a positive integer within the supported database quantity limit.

Success response — **200 OK**

```json
{
  "message": "Stock decreased successfully",
  "inventory": {
    "product_id": 1,
    "quantity": 13,
    "updated_at": "2026-11-12T10:30:00.000Z"
  }
}
```

Errors:

| HTTP status | Condition |
|---|---|
| 400 | Invalid product ID or quantity |
| 409 | Product inventory does not exist or available stock is insufficient |
| 401 / 403 | Authentication or role requirement not met |
| 500 | `{"message":"Failed to decrease stock"}` |

### 6.5 Increase stock

**PATCH** `/api/inventory/:productId/increase`

- Authentication: Required
- Required role: `inventory_manager` or `admin`

Path parameters:

| Parameter | Description |
|---|---|
| `productId` | Positive integer product ID |

Request body:

```json
{
  "quantity": 10
}
```

`quantity` must be a positive integer within the supported database quantity limit.

Success response — **200 OK**

```json
{
  "message": "Stock increased successfully",
  "inventory": {
    "product_id": 1,
    "quantity": 25,
    "updated_at": "2026-11-12T11:00:00.000Z"
  }
}
```

Errors:

| HTTP status | Condition |
|---|---|
| 400 | Invalid product ID or quantity |
| 404 | `{"message":"Product inventory not found"}` |
| 409 | `{"message":"Stock quantity limit exceeded"}` |
| 401 / 403 | Authentication or role requirement not met |
| 500 | `{"message":"Failed to increase stock"}` |

## 7. Reports Endpoints

All reports endpoints require authentication and one of these roles:

- `inventory_manager`
- `admin`

No request body is required for these endpoints.

### 7.1 Get stock summary

**GET** `/api/reports/stock-summary`

- Authentication: Required
- Required role: `inventory_manager` or `admin`
- Query parameters: None

Success response — **200 OK**

```json
{
  "product_count": 20,
  "products_with_inventory": 18,
  "products_without_inventory": 2,
  "total_stock_quantity": 450
}
```

The response is the summary object itself; it is not wrapped in another property.

Errors: Authentication/authorization errors described in Section 2. Unexpected errors are passed to Express error handling; this route does not define a route-specific JSON error response.

### 7.2 Get low-stock report

**GET** `/api/reports/low-stock`

- Authentication: Required
- Required role: `inventory_manager` or `admin`
- Query parameters: None

Success response — **200 OK**

```json
{
  "count": 1,
  "products": [
    {
      "product_id": 1,
      "name": "Wireless Mouse",
      "sku": "MOUSE-001",
      "category_id": 1,
      "quantity": 3,
      "low_stock_threshold": 5
    }
  ]
}
```

Errors: Authentication/authorization errors described in Section 2. Unexpected errors are passed to Express error handling; this route does not define a route-specific JSON error response.

### 7.3 Get stock grouped by category

**GET** `/api/reports/category-stock`

- Authentication: Required
- Required role: `inventory_manager` or `admin`

Query parameters:

| Parameter | Required | Description |
|---|---|---|
| `categoryId` | No | Optional positive integer category ID filter |

Example:

`GET /api/reports/category-stock?categoryId=1`

Success response — **200 OK**

```json
{
  "categories": [
    {
      "category_id": 1,
      "category_name": "Electronics",
      "product_count": 10,
      "products_with_inventory": 9,
      "total_stock_quantity": 250
    }
  ]
}
```

Errors:

| HTTP status | Condition |
|---|---|
| 400 | `{"message":"categoryId must be a positive integer"}` |
| 401 / 403 | Authentication or role requirement not met |

Unexpected errors are passed to Express error handling; this route does not define a route-specific JSON error response.

### 7.4 Get stock movement report

**GET** `/api/reports/stock-movement`

- Authentication: Required
- Required role: `inventory_manager` or `admin`

Query parameters:

| Parameter | Required | Description |
|---|---|---|
| `startDate` | Yes | Start date in `YYYY-MM-DD` format |
| `endDate` | Yes | End date in `YYYY-MM-DD` format; must be on or after `startDate` |

Example:

`GET /api/reports/stock-movement?startDate=2026-11-01&endDate=2026-11-12`

The date range is inclusive.

Success response — **200 OK**

```json
{
  "start_date": "2026-11-01",
  "end_date": "2026-11-12",
  "total_added": 100,
  "total_removed": 35,
  "net_change": 65,
  "daily": [
    {
      "date": "2026-11-01",
      "stock_added": 20,
      "stock_removed": 5,
      "net_change": 15
    }
  ]
}
```

Errors:

| HTTP status | Condition |
|---|---|
| 400 | `{"message":"startDate and endDate must be valid dates in YYYY-MM-DD format"}` |
| 400 | `{"message":"endDate must be greater than or equal to startDate"}` |
| 401 / 403 | Authentication or role requirement not met |

Unexpected errors are passed to Express error handling; this route does not define a route-specific JSON error response.

## 8. Endpoint Summary

| Method | Endpoint | Authentication | Required role |
|---|---|---|---|
| POST | `/api/auth/register` | No | None |
| POST | `/api/auth/login` | No | None |
| GET | `/api/auth/me` | Yes | Any authenticated role |
| POST | `/api/products/` | Yes | `inventory_manager`, `admin` |
| GET | `/api/products/` | Yes | Any authenticated role |
| GET | `/api/products/:id` | Yes | Any authenticated role |
| PATCH | `/api/products/:id` | Yes | `inventory_manager`, `admin` |
| DELETE | `/api/products/:id` | Yes | `admin` |
| POST | `/api/suppliers/` | Yes | `inventory_manager`, `admin` |
| GET | `/api/suppliers/` | Yes | Any authenticated role |
| GET | `/api/suppliers/:id` | Yes | Any authenticated role |
| PATCH | `/api/suppliers/:id` | Yes | `inventory_manager`, `admin` |
| DELETE | `/api/suppliers/:id` | Yes | `admin` |
| GET | `/api/inventory/history` | Yes | Any authenticated role |
| GET | `/api/inventory/low-stock` | Yes | `inventory_manager`, `admin` |
| GET | `/api/inventory/:productId` | Yes | Any authenticated role |
| PATCH | `/api/inventory/:productId/decrease` | Yes | `inventory_manager`, `admin` |
| PATCH | `/api/inventory/:productId/increase` | Yes | `inventory_manager`, `admin` |
| GET | `/api/reports/stock-summary` | Yes | `inventory_manager`, `admin` |
| GET | `/api/reports/low-stock` | Yes | `inventory_manager`, `admin` |
| GET | `/api/reports/category-stock` | Yes | `inventory_manager`, `admin` |
| GET | `/api/reports/stock-movement` | Yes | `inventory_manager`, `admin` |

**Total: 22 endpoints across 5 route modules.**
