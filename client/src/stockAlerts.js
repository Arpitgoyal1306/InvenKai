export const defaultLowStock = 3;

export function isLowStock(product) {
  return (
    !product.archived &&
    product.quantity <= (product.low_stock_threshold ?? defaultLowStock)
  );
}
