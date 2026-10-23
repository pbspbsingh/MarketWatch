import type { TradeLogFilters } from "../../api/tradeLogs";

const storageKey = "market-watch.trade-logs-filters-v1";
export const initialFilters: TradeLogFilters = { symbol: "", direction: [], status: [], tag_id: [], tag_scope: [], start: "", end: "" };

function selection<T extends string>(value: unknown, options: readonly T[]): T[] {
  return Array.isArray(value) ? options.filter(option => value.includes(option)) : [];
}

function date(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return "";
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value ? value : "";
}

export function restoreFilters(): TradeLogFilters {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(storageKey) ?? "null");
    if (!value || typeof value !== "object" || Array.isArray(value)) return initialFilters;
    const saved = value as Record<string, unknown>;
    let start = date(saved.start);
    let end = date(saved.end);
    if (start && end && start > end) { start = ""; end = ""; }
    return {
      symbol: typeof saved.symbol === "string" ? saved.symbol : "",
      direction: selection(saved.direction, ["long", "short"] as const),
      status: selection(saved.status, ["open", "closed", "win", "loss"] as const),
      tag_id: Array.isArray(saved.tag_id) ? [...new Set(saved.tag_id.filter((id): id is number => Number.isSafeInteger(id) && id > 0))] : [],
      tag_scope: selection(saved.tag_scope, ["trade", "leg"] as const),
      start,
      end,
    };
  } catch { /* Invalid or unavailable storage must not block the journal. */ }
  return initialFilters;
}

export function saveFilters(filters: TradeLogFilters): void {
  try { localStorage.setItem(storageKey, JSON.stringify(filters)); }
  catch { /* Filters remain usable when browser storage is unavailable. */ }
}
