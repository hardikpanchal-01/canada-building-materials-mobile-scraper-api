/** Coerce string-typed numbers from PostgreSQL to actual numbers */
export function coerceRowNumbers(rows) {
  if (rows.length === 0) return rows;
  return rows.map((row) => {
    const cleaned = {};
    for (const [k, v] of Object.entries(row)) {
      if (v !== null && v !== undefined && typeof v === "string" && v.trim() !== "" && !isNaN(Number(v))) {
        cleaned[k] = Number(v);
      } else {
        cleaned[k] = v;
      }
    }
    return cleaned;
  });
}

export function formatValue(
  value,
  format
) {
  if (value == null || isNaN(value)) return "—";

  // Detect year-like values (1900-2100) - never compact these
  if (value >= 1900 && value <= 2100 && Number.isInteger(value)) {
    return String(value);
  }

  switch (format) {
    case "percentage":
      return `${value.toFixed(1)}%`;
    case "currency":
      return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        notation: "compact",
        maximumFractionDigits: 1,
      }).format(value);
    case "compact":
      return new Intl.NumberFormat("en-US", {
        notation: "compact",
        maximumFractionDigits: 1,
      }).format(value);
    case "number":
      return new Intl.NumberFormat("en-US").format(value);
    default:
      if (Math.abs(value) >= 1_000_000) {
        return new Intl.NumberFormat("en-US", {
          notation: "compact",
          maximumFractionDigits: 1,
        }).format(value);
      }
      return new Intl.NumberFormat("en-US", {
        maximumFractionDigits: 2,
      }).format(value);
  }
}
