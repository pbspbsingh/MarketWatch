import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, useNavigate } from "react-router-dom";
import { AppSettingsProvider } from "../../src/app/AppSettings";
import { MarketWatchPage } from "../../src/features/market-watch/MarketWatchPage";
import "../../src/app/styles.css";

localStorage.setItem("market-watch.settings.v1", JSON.stringify({ chartEngine: "lightweight", theme: "dark" }));
localStorage.setItem("market-watch.chart-interval", "D");
const errors: string[] = [];
window.addEventListener("error", event => errors.push(event.message));
window.addEventListener("unhandledrejection", event => errors.push(String(event.reason)));
const dates = Array.from({ length: 160 }, (_, i) => new Date(Date.UTC(2026, 4, i + 1)).toISOString().slice(0, 10))
  .filter(date => ![0, 6].includes(new Date(date).getUTCDay()));
const executions = ["Open", "Add", "Reduce", "Close"].map((action, i) => ({
  id: i + 1, market_date: dates.at(-10 + i * 2)!, executed_at: `${dates.at(-10 + i * 2)}T14:00:00Z`,
  side: i < 2 ? "buy" : "sell", action,
}));
const requests: string[] = [];
let releaseTrade: (() => void) | undefined;
let holdTrade = false;
const fetchResource = window.fetch.bind(window);
window.fetch = async (input, init = {}) => {
  const url = new URL(String(input), location.origin);
  if (!url.pathname.startsWith("/api/")) return fetchResource(input, init);
  requests.push(url.pathname + url.search);
  const body = init.body ? JSON.parse(String(init.body)) : {};
  let result: unknown;
  if (url.pathname.startsWith("/api/trade-logs/")) {
    const id = Number(url.pathname.split("/").at(-1));
    if (id === 404) return new Response(JSON.stringify({ error: "Trade not found" }), { status: 404 });
    // Deliberately ignore AbortSignal so the test also checks late-response guards.
    if (id === 42 && holdTrade) await new Promise<void>(resolve => { releaseTrade = resolve; });
    result = { id, symbol: "AAPL", executions: id === 43 ? [executions[0], executions[3]] : executions };
  } else if (url.pathname.startsWith("/api/market-chart/")) {
    const symbol = url.pathname.split("/")[3];
    const interval = url.searchParams.get("interval");
    const comparison = url.searchParams.get("comparison_symbol");
    const chartDates = interval === "weekly" ? dates.filter(date => new Date(date).getUTCDay() === 1) : dates;
    result = { symbol, interval,
      candles: chartDates.map((date, i) => ({ date, open: 100 + i, high: 103 + i, low: 98 + i, close: 101 + i, volume: 100_000 })),
      moving_averages: [], volume_average: { period: 50, points: [] }, indicators: [],
      earliest_date: chartDates[0], latest_date: chartDates.at(-1), has_more_before: false,
      relative_strength: comparison ? { comparison_symbol: comparison,
        line: { moving_average_period: Number(url.searchParams.get("relative_strength_period")), points: [] },
        structure: { confirmed: [], provisional: null, trend: "unclear" } } : null,
    };
  } else if (url.pathname === "/api/chart-summary") {
    result = { symbol: body.symbol, tradingview_symbol: `NASDAQ:${body.symbol}`, company_name: body.symbol,
      industry: null, themes: [], sector_benchmark: null, theme_benchmarks: [], benchmark_symbol: "SPY",
      benchmark_company_name: "S&P 500", adr_percent: 2, extension_from_50_sma: 1, average_volume: 1_000_000 };
  } else if (url.pathname === "/api/ticker-strength/benchmarks") {
    result = { global: { kind: "market", name: "S&P 500", symbol: "SPY" }, contextual: [], latest_session: dates.at(-1) };
  } else if (url.pathname === "/api/ticker-ranking") {
    result = { symbol: body.symbol, watchlist_ids: [], performance: { day: 1, week: 2, month: 3, quarter: 4, half_year: 5, year: 6 }, absolute_strength: 50, adr_percent: 2,
      latest_close: 100, average_volume: 1_000_000, above_200_sma: true, rs_trend: "unclear" };
  } else if (url.pathname === "/api/ticker-group-summary") result = { selected_groups: [], related_groups: [] };
  else if (url.pathname === "/api/ticker-membership") result = ["AAPL", "MSFT"];
  else if (url.pathname.endsWith("/next-earnings")) result = null;
  else if (["/api/industries", "/api/theme-rankings", "/api/sector-rankings", "/api/watchlists", "/api/watchlists/memberships"].includes(url.pathname)) result = [];
  else throw new Error(`Unexpected fixture request: ${url.pathname}`);
  return new Response(JSON.stringify(result), { headers: { "Content-Type": "application/json" } });
};

// Keep the fixture fully local; price and ticker streams are idle.
class IdleSocket extends EventTarget {
  static OPEN = 1;
  static CONNECTING = 0;
  readyState = 0;
  constructor() { super(); queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event("open")); }); }
  send(data: string) {
    const request = JSON.parse(data);
    if (request.type === "stream") queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", {
      data: JSON.stringify({ type: "complete", request_id: request.request_id }),
    })));
  }
  close() { this.readyState = 3; this.dispatchEvent(new Event("close")); }
}
window.WebSocket = IdleSocket as unknown as typeof WebSocket;

const draws: { text: string; canvas: HTMLCanvasElement }[] = [];
const fillText = CanvasRenderingContext2D.prototype.fillText;
CanvasRenderingContext2D.prototype.fillText = function(text, x, y, maxWidth) {
  if (/^[OARC]\d+$/.test(text)) draws.push({ text, canvas: this.canvas });
  if (maxWidth === undefined) fillText.call(this, text, x, y); else fillText.call(this, text, x, y, maxWidth);
};
let navigate: ReturnType<typeof useNavigate>;
function Fixture() {
  const routerNavigate = useNavigate();
  useEffect(() => { navigate = routerNavigate; }, [routerNavigate]);
  return <main style={{ height: "100dvh" }}><MarketWatchPage /></main>;
}
createRoot(document.getElementById("root")!).render(<BrowserRouter><AppSettingsProvider><Fixture /></AppSettingsProvider></BrowserRouter>);

const pause = (ms = 100) => new Promise(resolve => setTimeout(resolve, ms));
function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
async function waitFor(predicate: () => unknown, label: string) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await pause(); }
  throw new Error(`Timed out: ${label}. Browser errors: ${errors.join("; ")}. Last requests: ${requests.slice(-6).join(", ")}`);
}
async function repaint() {
  draws.length = 0;
  document.body.style.paddingRight = "2px";
  await pause();
  document.body.style.paddingRight = "0";
  await pause(250);
}
function markerTexts(chartIndex: number) {
  const chart = document.querySelectorAll(".ticker-lens-chart-stage .market-chart-container")[chartIndex];
  return [...new Set(draws.filter(draw => chart?.contains(draw.canvas)).map(draw => draw.text))].sort();
}
async function ready(symbol = "AAPL") {
  await waitFor(() => document.querySelector(".chart-header-identity h2")?.textContent?.endsWith(symbol)
    && document.querySelectorAll(".ticker-lens-chart-stage .market-chart-container canvas").length > 0
    && !document.querySelector(".ticker-lens-chart-stage .panel-status"), `loaded ${symbol} chart`);
  await repaint();
}
async function runChecks() {
  await ready();
  assert(!requests.some(path => path.startsWith("/api/trade-logs/")), "Ordinary visits must not fetch a trade");
  assert(markerTexts(0).length === 0, "Ordinary chart has no trade markers");
  navigate("?ticker=AAPL&trade_id=42");
  await waitFor(() => draws.some(draw => draw.text === "A2"), "linked trade markers");
  await repaint();
  assert(markerTexts(0).join() === "A2,C4,O1,R3", "Top chart shows all four execution markers");
  assert(markerTexts(1).length === 0, "Benchmark has no trade markers");
  ([...document.querySelectorAll(".ticker-list-item .ranked-name")].find(element => element.textContent === "MSFT")!.closest("button") as HTMLElement).click();
  await ready("MSFT");
  assert(markerTexts(0).length === 0, "Markers cannot leak to a different ticker");
  ([...document.querySelectorAll(".ticker-list-item .ranked-name")].find(element => element.textContent === "AAPL")!.closest("button") as HTMLElement).click();
  await ready();
  assert(markerTexts(0).length === 4, "Returning to the linked ticker restores markers");
  (document.querySelector('.chart-header-controls [value="W"]') as HTMLElement).click();
  await waitFor(() => requests.some(path => path.includes("interval=weekly")), "weekly request");
  await ready();
  assert(markerTexts(0).length === 0, "Daily executions must not attach to unrelated weekly candles");
  (document.querySelector('.chart-header-controls [value="D"]') as HTMLElement).click();
  await ready();
  const count = requests.filter(path => path.startsWith("/api/trade-logs/")).length;
  navigate("?ticker=AAPL&trade_id=invalid");
  await pause(); await repaint();
  assert(requests.filter(path => path.startsWith("/api/trade-logs/")).length === count, "Invalid IDs must not be fetched");
  assert(markerTexts(0).length === 0, "Removing valid trade context clears its markers");
  navigate("?ticker=AAPL&trade_id=404");
  await waitFor(() => document.body.textContent?.includes("Trade markers unavailable"), "missing trade notice");
  await repaint();
  assert(markerTexts(0).length === 0, "Deleted trades do not leave stale markers");
  assert(document.querySelectorAll(".market-chart-container canvas").length > 0, "Failed trade lookup leaves charts usable");
  holdTrade = true;
  navigate("?ticker=AAPL&trade_id=42");
  await waitFor(() => releaseTrade, "delayed trade request");
  navigate("?ticker=AAPL&trade_id=43");
  await waitFor(() => draws.some(draw => draw.text === "C2"), "replacement trade markers");
  releaseTrade!();
  await pause(); await repaint();
  assert(markerTexts(0).join() === "C2,O1", "A late response cannot overwrite the current trade");
  navigate("?ticker=AAPL");
  await pause(); await repaint();
  assert(markerTexts(0).length === 0, "Clearing trade context restores the ordinary chart");
  assert(errors.length === 0, `Browser errors: ${errors.join("; ")}`);
  return { passed: ["ordinary visits unchanged", "execution markers rendered", "benchmark excluded", "ticker isolation", "daily-only markers", "invalid ID ignored", "deleted trade handled", "late response ignored", "context removal"] };
}
(window as unknown as { tradeMarkerTest: unknown }).tradeMarkerTest = { runChecks };
