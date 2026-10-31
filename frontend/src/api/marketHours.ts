import type { MarketHours } from "./generated/contracts";
export type { MarketHours } from "./generated/contracts";

export async function fetchMarketHours(signal: AbortSignal): Promise<MarketHours> {
  const response = await fetch("/api/market/hours", { signal, cache: "no-store" });
  if (!response.ok) throw new Error(`Could not load market hours: HTTP ${response.status}`);
  const hours = await response.json() as MarketHours;
  if (typeof hours.is_trading_day !== "boolean" || typeof hours.time_zone !== "string"
    || !/^\d{4}-\d{2}-\d{2}$/.test(hours.market_date)
    || ![hours.server_time, hours.closes_at, hours.day_ends_at].every(value => typeof value === "string" && Number.isFinite(Date.parse(value)))
    || Date.parse(hours.day_ends_at) <= Date.parse(hours.server_time)) throw new Error("Invalid market-hours response");
  return hours;
}

export function beforeMarketClose(hours: MarketHours, now: number) {
  return hours.is_trading_day && now < Date.parse(hours.closes_at) && now < Date.parse(hours.day_ends_at);
}

export interface MarketHoursState { hours?: MarketHours; beforeClose: boolean; error?: string }

export function observeMarketHours(receive: (state: MarketHoursState) => void) {
  let state: MarketHoursState = { beforeClose: false };
  const emit = (change: Partial<MarketHoursState>) => { state = { ...state, ...change }; receive(state); };
  let active = true;
  let pending: AbortController | undefined;
  let closeTimer: number | undefined;
  let dayTimer: number | undefined;
  let lastHours: MarketHours | undefined;
  let receivedAt = 0;
  const load = () => {
    pending?.abort();
    const controller = new AbortController(); pending = controller;
    void fetchMarketHours(controller.signal).then(hours => {
      if (!active || controller.signal.aborted) return;
      window.clearTimeout(closeTimer); window.clearTimeout(dayTimer);
      const serverTime = Date.parse(hours.server_time);
      lastHours = hours; receivedAt = Date.now();
      emit({ hours, beforeClose: beforeMarketClose(hours, serverTime), error: undefined });
      if (Date.parse(hours.closes_at) > serverTime) closeTimer = window.setTimeout(() => emit({ beforeClose: false }), Date.parse(hours.closes_at) - serverTime);
      dayTimer = window.setTimeout(() => { emit({ beforeClose: false }); load(); }, Date.parse(hours.day_ends_at) - serverTime);
    }).catch((cause: unknown) => {
      if (!active || controller.signal.aborted) return;
      emit({ hours: undefined, beforeClose: false, error: cause instanceof Error ? cause.message : "Could not load market hours" });
    });
  };
  const focus = () => {
    if (document.visibilityState !== "visible") return;
    if (lastHours !== undefined && !beforeMarketClose(lastHours, Date.parse(lastHours.server_time) + Date.now() - receivedAt)) emit({ beforeClose: false });
    load();
  };
  load(); window.addEventListener("focus", focus); document.addEventListener("visibilitychange", focus);
  return () => {
    active = false; pending?.abort(); window.clearTimeout(closeTimer); window.clearTimeout(dayTimer);
    window.removeEventListener("focus", focus); document.removeEventListener("visibilitychange", focus);
  };
}
