import type { TradeLog, TradeLogExecutionInput, TradeLogInput } from "../../api/tradeLogs";
const currency = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
const quantity = new Intl.NumberFormat("en-US", { maximumFractionDigits: 6 });
const date = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });
export const money = (value: string | null | undefined) => value == null ? "—" : currency.format(Number(value));
export const shares = (value: string) => quantity.format(Number(value));
export const pnlClass = (value: string) => Number(value) > 0 ? "tl-positive" : Number(value) < 0 ? "tl-negative" : "";
export const percent = (value: number | null) => value === null ? "—" : `${value.toFixed(1)}%`;
export const localDate = (value: string) => date.format(new Date(value));
export function localDateTime(value: string) {
  if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) return value.slice(0, 16);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}
export function newExecution(side: "buy" | "sell" = "buy", amount = ""): TradeLogExecutionInput {
  const date = new Date();
  date.setUTCSeconds(0, 0);
  return { id: null, executed_at: date.toISOString(), side, quantity: amount, price: "", fee: "0", notes: "", tag_ids: [] };
}
export function draftFromTrade(trade: TradeLog): TradeLogInput {
  return { revision: trade.revision, symbol: trade.symbol, direction: trade.direction ?? "long", notes: trade.notes, tag_ids: [...trade.tag_ids], executions: trade.executions.map(({ id, executed_at, side, quantity, price, fee, notes, tag_ids }) => ({ id, executed_at, side, quantity, price, fee, notes, tag_ids: [...tag_ids] })) };
}
export function payload(draft: TradeLogInput): TradeLogInput {
  return { ...draft, symbol: draft.symbol.trim().toUpperCase(), executions: draft.executions.map(leg => {
    const local = localDateTime(leg.executed_at);
    if (!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d$/.test(local)) throw new RangeError("Enter time as HH:mm (00:00–23:59)");
    const date = new Date(leg.executed_at);
    if (Number.isNaN(date.getTime()) || localDateTime(date.toISOString()) !== local) throw new RangeError("Enter a valid local date and time");
    date.setUTCSeconds(0, 0);
    return { ...leg, executed_at: date.toISOString() };
  }) };
}
export function newDraft(): TradeLogInput { return { revision: null, symbol: "", direction: "long", notes: "", tag_ids: [], executions: [newExecution()] }; }
export const errorMessage = (error: unknown) => error instanceof Error ? error.message : "Unable to complete the request";
