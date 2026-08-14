export function money(value: string | null) {
  if (value === null) return "—";
  const number = Number(value);
  if (!Number.isFinite(number)) return value;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(number);
}

export function signedMoney(value: string | null) {
  const formatted = money(value);
  return value !== null && Number(value) > 0 ? `+${formatted}` : formatted;
}

export function moneyInput(value: string | null) {
  if (value === null || value.trim() === "") return "";
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(2) : value;
}

export function decimal(value: string | null, suffix = "") {
  if (value === null) return "—";
  const number = Number(value);
  return `${Number.isFinite(number) ? number.toLocaleString(undefined, { maximumFractionDigits: 2 }) : value}${suffix}`;
}

export function localDate(value: string | null, timezone: string) {
  if (value === null) return "Unknown";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

export function pnlClass(value: string | null) {
  if (value === null || Number(value) === 0) return "trade-value-neutral";
  return Number(value) > 0 ? "trade-value-positive" : "trade-value-negative";
}
