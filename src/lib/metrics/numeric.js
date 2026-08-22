export function requireMetricNumber(value, context, { integer = false } = {}) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || (integer && !Number.isInteger(value))) {
    throw new Error(`invalid Prometheus metric number: ${context}`);
  }
  return Object.is(value, -0) ? 0 : value;
}
