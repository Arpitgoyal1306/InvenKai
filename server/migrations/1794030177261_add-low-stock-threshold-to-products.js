export const shorthands = undefined;

export const up = (pgm) => {
  // Add a nullable threshold to products.
  // NULL means that low-stock monitoring is not configured.
  pgm.addColumn("products", {
    low_stock_threshold: {
      type: "integer",
      notNull: false,
      default: null,
    },
  });

  // Allow NULL and zero, but reject negative thresholds.
  pgm.addConstraint(
    "products",
    "products_low_stock_threshold_non_negative",
    {
      check:
        "low_stock_threshold IS NULL OR low_stock_threshold >= 0",
    },
  );
};

export const down = (pgm) => {
  // Remove the constraint before removing the column.
  pgm.dropConstraint(
    "products",
    "products_low_stock_threshold_non_negative",
  );

  pgm.dropColumn("products", "low_stock_threshold");
};