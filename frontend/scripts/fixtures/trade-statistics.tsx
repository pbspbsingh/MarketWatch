import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { AppSettingsProvider, useAppSettings } from "../../src/app/AppSettings";
import { TradeLogsPage } from "../../src/features/trade-logs/TradeLogsPage";
import "../../src/app/styles.css";

const errors: string[] = [];
window.addEventListener("error", event => errors.push(event.message));
window.addEventListener("unhandledrejection", event => errors.push(String(event.reason)));
const tags = Array.from({ length: 24 }, (_, index) => ({ id: index + 1, name: index === 0 ? "Breakout" : index === 1 ? "Pullback" : `Setup ${index + 1}`, description: null as string | null, revision: 1, trade_count: 0, execution_count: 0 }));
const trades = Array.from({ length: 120 }, (_, i) => {
  const opened = new Date(Date.UTC(2026, i % 9, i % 26 + 1, 14));
  const closed = new Date(opened.getTime() + (i % 14 + 1) * 86_400_000);
  const ret = i === 119 ? 80 : (i % 15 - 5) * 0.8;
  const pnl = ret * 10;
  const symbol = ["AAPL", "MSFT", "NVDA", "AMZN", "META", "GOOG", "TSLA", "AMD", "PLTR", "NFLX", "SHOP", "UBER", "COIN", "SNOW", "NET"][i % 15];
  const tag_ids = i % 5 === 0 ? [] : [i % 24 + 1];
  const executionTags = i % 3 === 0 ? [1, 2] : i % 2 === 0 ? [2] : [];
  const short = i % 4 === 0;
  const execution = (id: number, at: Date, entry: boolean) => ({
    id, executed_at: at.toISOString(), market_date: at.toISOString().slice(0, 10),
    side: entry !== short ? "buy" : "sell", action: entry ? "Open" : "Close", quantity: "10", price: String(entry ? 100 : 100 + (short ? -ret : ret)),
    fee: "0", remaining_quantity: entry ? "10" : "0", realized_pnl: entry ? "0" : pnl.toFixed(6), net_return_percent: entry ? null : ret,
    notes: "", tag_ids: entry ? executionTags : [],
  });
  return { id: i + 1, revision: 1, symbol, direction: short ? "short" : "long", notes: "Browser test fixture", tag_ids,
    executions: [execution(i * 2 + 1, opened, true), execution(i * 2 + 2, closed, false)],
    summary: { status: "closed", opened_at: opened.toISOString(), closed_at: closed.toISOString(), remaining_quantity: "0", average_cost: null,
      average_entry_price: "100", fees: "0", realized_pnl: pnl.toFixed(6), realized_return_percent: ret, net_return_percent: ret, entry_notional: "1000" },
  };
});
const openTrades = [false, true].map((short, index) => ({
  ...trades[index], id: 1001 + index, direction: short ? "short" : "long", tag_ids: [1, 2],
  executions: [
    { ...trades[index].executions[0], id: 2001 + index * 2, executed_at: "2026-10-19T14:00:00Z", market_date: "2026-10-19", side: short ? "sell" : "buy", action: "Open", quantity: "100", price: "100", remaining_quantity: "100", realized_pnl: "0", net_return_percent: null },
    { ...trades[index].executions[1], id: 2002 + index * 2, executed_at: "2026-10-20T14:00:00Z", market_date: "2026-10-20", side: short ? "buy" : "sell", action: "Reduce", quantity: "20", price: short ? "90" : "110", remaining_quantity: "80", realized_pnl: "200", net_return_percent: 10 },
  ],
  summary: { ...trades[index].summary, status: "open", opened_at: "2026-10-19T14:00:00Z", closed_at: null, remaining_quantity: "80", average_cost: "100", average_entry_price: "100", realized_pnl: "200", realized_return_percent: 10, net_return_percent: null, entry_notional: "10000" },
}));
const valuations = [
  { trade_id: 1001, revision: 1, mark_date: "2026-10-21", mark_price: "110", realized_pnl: "200", unrealized_pnl: "800", total_pnl: "1000", net_return_percent: 10 },
  { trade_id: 1002, revision: 1, mark_date: "2026-10-22", mark_price: "95", realized_pnl: "200", unrealized_pnl: "400", total_pnl: "600", net_return_percent: 6 },
];
let valuationMode: "valid" | "missing" | "stale" | "error" = "valid";
let hiddenTradeId: number | null = null;
const allTrades = [...trades, ...openTrades];
const stats = { closed_trades: 120, winners: 0, losers: 0, breakeven: 0, net_pnl: "0", average_pnl: null, average_winner: null, average_loser: null, win_rate: null, profit_factor: null };
window.fetch = async (url, init = {}) => {
  const path = String(url);
  if (init.method && init.method !== "GET") {
    const match = new URL(path, location.origin).pathname.match(/^\/api\/trade-logs\/tags(?:\/(\d+))?$/);
    if (!match || !["POST", "PUT"].includes(init.method)) throw new Error("Only isolated in-memory tag writes are permitted");
    const input = JSON.parse(String(init.body));
    const tag = match[1] ? tags.find(tag => tag.id === Number(match[1])) : undefined;
    if (match[1] && (!tag || tag.revision !== input.revision)) return new Response(JSON.stringify({ error: "This record changed in another tab" }), { status: 409 });
    const saved = { id: tag?.id ?? Math.max(...tags.map(tag => tag.id)) + 1, name: input.name.trim(),
      description: input.description?.trim() || null, revision: (tag?.revision ?? 0) + 1, trade_count: 0, execution_count: 0 };
    if (tag) Object.assign(tag, saved); else tags.push(saved);
    return new Response(JSON.stringify(saved), { headers: { "Content-Type": "application/json" } });
  }
  const query = new URL(path, location.origin).searchParams;
  const tradeId = new URL(path, location.origin).pathname.match(/^\/api\/trade-logs\/(\d+)$/)?.[1];
  const filtered = allTrades.filter(trade => trade.id !== hiddenTradeId && (!query.get("symbol") || trade.symbol.includes(query.get("symbol")!)));
  let body: unknown;
  if (tradeId) {
    body = allTrades.find(trade => trade.id === Number(tradeId));
    if (!body) return new Response(JSON.stringify({ error: "Trade not found" }), { status: 404 });
  }
  else if (path.includes("/market-chart/")) body = { candles: [] };
  else if (path.endsWith("/hourly")) body = { symbol: "AAPL", candles: [], history_limited: false };
  else if (path.endsWith("/valuations")) {
    if (valuationMode === "error") return new Response(JSON.stringify({ error: "Fixture price refresh failed" }), { status: 503, headers: { "Content-Type": "application/json" } });
    body = valuationMode === "missing" ? valuations.map(mark => ({ ...mark, total_pnl: null, net_return_percent: null, mark_price: null, mark_date: null }))
      : valuationMode === "stale" ? valuations.map(mark => ({ ...mark, revision: 0 })) : valuations;
  }
  else body = { trades: filtered, tags, statistics: stats, tag_statistics: [], untagged_trades: 0, open_trades: filtered.filter(trade => trade.summary.status === "open").length, open_realized_pnl: "400", time_zone: "America/Los_Angeles" };
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
};

function Fixture() {
  const { setTheme } = useAppSettings();
  return <><div style={{ height: 48, padding: 12, fontSize: 12 }}>MarketWatch · Statistics verification <button onClick={() => setTheme("light")}>Light theme</button><button onClick={() => setTheme("dark")}>Dark theme</button></div><main style={{ height: "calc(100dvh - 48px)" }}><TradeLogsPage /></main></>;
}
createRoot(document.getElementById("root")!).render(<BrowserRouter><AppSettingsProvider><Fixture /></AppSettingsProvider></BrowserRouter>);

const pause = () => new Promise(resolve => setTimeout(resolve, 70));
async function waitFor(predicate: () => unknown, label: string) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await pause(); }
  throw new Error(`Timed out: ${label}`);
}
function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
const click = (element: Element | null) => { assert(element, "Missing element to click"); element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); };
const escape = () => (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
async function section(label: string) {
  click([...document.querySelectorAll('.tl-tabs [role="tab"]')].find(tab => tab.textContent === label) ?? null);
  await pause();
}
async function select(label: string, option: string) {
  const input = [...document.querySelectorAll('[role="combobox"]')].find(el => el.getAttribute("aria-labelledby")?.split(" ").some(id => document.getElementById(id)?.textContent === label));
  assert(input, `Missing select ${label}`);
  input.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
  await waitFor(() => document.querySelector('[role="listbox"]'), `open ${label}`);
  click([...document.querySelectorAll('[role="option"]')].find(el => el.textContent === option) ?? null);
  await pause();
}
async function subtab(label: string) {
  const tabs = document.querySelector<HTMLElement>(".tl-stats-tabs");
  if (tabs && getComputedStyle(tabs).display !== "none") click([...tabs.querySelectorAll('[role="tab"]')].find(tab => tab.textContent === label) ?? null);
  else await select("Statistics chart", label);
  await pause();
}
async function tooltip(element: Element | null, expected: string, leave = true) {
  assert(element, "Tooltip target missing");
  element.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
  await waitFor(() => [...document.querySelectorAll('[role="tooltip"]')].some(tip => tip.textContent?.includes(expected)), `tooltip: ${expected}`);
  const tip = [...document.querySelectorAll<HTMLElement>('[role="tooltip"]')].find(tip => tip.textContent?.includes(expected))!;
  const popper = tip.closest<HTMLElement>(".MuiTooltip-popper")!;
  assert(popper.getAttribute("data-popper-placement")?.startsWith("top"), "Control tooltip must stay above its control");
  assert(getComputedStyle(popper).pointerEvents === "none", "Control tooltip must not capture pointer input");
  assert(tip.getBoundingClientRect().bottom <= element.getBoundingClientRect().top + 1, "Tooltip overlaps its control");
  if (leave) {
    element.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body }));
    await pause();
  }
}
async function dropdownTooltip(label: string, option: string, hint: string, multiple: boolean) {
  const input = [...document.querySelectorAll<HTMLElement>('[role="combobox"]')].find(el => el.getAttribute("aria-labelledby")?.split(" ").some(id => document.getElementById(id)?.textContent === label));
  assert(input, `Missing select ${label}`);
  const control = input.closest(".MuiFormControl-root")!;
  assert(!control.hasAttribute("title"), "Avoid a duplicate browser-native tooltip below the control");
  await tooltip(control, hint, false);
  const rect = input.getBoundingClientRect();
  const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
  assert(hit && control.contains(hit), `Tooltip intercepts clicks on ${label}`);
  input.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
  await waitFor(() => document.querySelector('[role="listbox"]'), `open ${label} with tooltip visible`);
  await waitFor(() => !document.querySelector('[role="tooltip"]'), "Dismiss tooltip when menu opens");
  const item = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(el => el.textContent === option);
  assert(item, `Missing option ${option}`);
  item.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
  await new Promise(resolve => setTimeout(resolve, 650));
  assert(!document.querySelector('[role="tooltip"]'), "Tooltip must not reopen over a dropdown menu");
  const itemRect = item.getBoundingClientRect();
  const itemHit = document.elementFromPoint(itemRect.x + itemRect.width / 2, itemRect.y + itemRect.height / 2);
  assert(itemHit && item.contains(itemHit), "Dropdown options remain clickable");
  click(item); await pause();
  if (multiple) { click(item); escape(); await pause(); }
  else await select(label, "P&L %");
  input.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body }));
  await waitFor(() => !document.querySelector('[role="listbox"]'), "Close dropdown");
  input.focus();
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", code: "ArrowDown", bubbles: true, cancelable: true }));
  await waitFor(() => document.querySelector('[role="listbox"]'), "Keyboard opens dropdown without tooltip interference");
  await new Promise(resolve => setTimeout(resolve, 650));
  assert(!document.querySelector('[role="tooltip"]'), "Tooltip stays hidden during keyboard menu interaction");
  escape();
  await waitFor(() => !document.querySelector('[role="listbox"]'), "Escape closes dropdown");
  input.blur(); await pause();
}
function assertFits() {
  const dashboard = document.querySelector<HTMLElement>(".tl-statistics-dashboard")!;
  const chart = document.querySelector<HTMLElement>(".tl-stats-chart");
  for (const element of [document.documentElement, document.querySelector<HTMLElement>("#tl-panel-1")!, dashboard, document.querySelector<HTMLElement>(".tl-stats-view")!]) {
    assert(element.scrollHeight <= element.clientHeight + 2, `Vertical overflow on ${element.className || element.id}: ${element.scrollHeight}/${element.clientHeight}`);
    assert(element.scrollWidth <= element.clientWidth + 2, `Horizontal overflow on ${element.className || element.id}`);
  }
  assert(chart && chart.getBoundingClientRect().height > 75, "Chart lacks usable height");
  const footer = document.querySelector(".tl-stats-footer")!.getBoundingClientRect();
  assert(footer.bottom <= innerHeight + 1, "Statistics footer outside viewport");
}
async function verifyLayout() {
  await section("Statistics");
  for (const label of ["Overview", "Distribution", "Tags", "Timing", "Duration", "Symbols"]) { await subtab(label); assertFits(); }
  await subtab("Distribution");
  assert(errors.length === 0, `Browser errors: ${errors.join("; ")}`);
  return { width: innerWidth, height: innerHeight, charts: 6, noScrolling: true };
}
async function verifyDrillLayout() {
  const bins = [...document.querySelectorAll<SVGGElement>('.tl-stats-chart [role="button"]')]
    .map(element => ({ element, count: Number(element.getAttribute("aria-label")?.match(/\n(\d+) trades/)?.[1]) }))
    .filter(bin => bin.count > 0).sort((a, b) => a.count - b.count);
  assert(bins.length > 1, "Distribution has small and large groups to inspect");
  for (const bin of [bins[0], bins.at(-1)!]) {
    click(bin.element);
    await waitFor(() => document.querySelector(".tl-stats-drill"), "drill-down overlay");
    await pause();
    const dialog = document.querySelector<HTMLElement>(".tl-stats-drill")!;
    const content = dialog.querySelector<HTMLElement>(".MuiDialogContent-root")!;
    assert(dialog.querySelectorAll("tbody tr").length === bin.count, "All matching trades render without pagination");
    assert(!dialog.querySelector(".MuiPagination-root"), "No pagination in drill-down overlay");
    const rect = dialog.getBoundingClientRect();
    assert(rect.top >= 0 && rect.bottom <= innerHeight && rect.left >= 0 && rect.right <= innerWidth, "Drill-down fits within viewport");
    if (bin.count === 1) assert(rect.height < 220, "A single trade should produce a compact overlay");
    if (content.scrollHeight > content.clientHeight + 2) {
      content.scrollTop = content.scrollHeight;
      await pause();
      assert(content.scrollTop > 0, "Long matching-trade lists scroll internally");
      const header = dialog.querySelector("th")!.getBoundingClientRect();
      assert(Math.abs(header.top - content.getBoundingClientRect().top) <= 1, "Trade column headers stay visible while scrolling");
      const last = dialog.querySelector("tbody tr:last-child")!.getBoundingClientRect();
      assert(last.bottom <= content.getBoundingClientRect().bottom + 1, "Last trade is reachable without pagination");
    }
    click(dialog.querySelector('[aria-label="Close matching trades"]'));
    await waitFor(() => !document.querySelector(".tl-stats-drill"), "close compact overlay");
  }
  return { compactDrillDown: true, allRows: true, internalScrolling: true, width: innerWidth, height: innerHeight };
}
async function runChecks() {
  await waitFor(() => document.querySelector(".tl-trade-row"), "Trade Logs snapshot");
  const tickerLink = document.querySelector<HTMLAnchorElement>(".tl-trade-row a")!;
  const linkedId = new URL(tickerLink.href).searchParams.get("trade_id");
  assert(tickerLink.target === "_blank" && linkedId, "Table ticker opens the trade-linked Market Watch page in a new tab");
  assert(new URL(tickerLink.href).searchParams.get("ticker") === tickerLink.textContent, "Table link carries its ticker");
  window.addEventListener("click", event => event.preventDefault(), { capture: true, once: true });
  click(tickerLink);
  await pause();
  assert(!document.querySelector(".tl-chart-drawer-paper .tl-trade-details"), "Ticker link does not also select its row");
  click(tickerLink.closest("tr")!.querySelector(".tl-date-link"));
  await waitFor(() => document.querySelector(".tl-chart-drawer-paper .tl-trade-details"), "row selection remains available");
  assert(document.querySelector<HTMLAnchorElement>(".tl-chart-drawer-paper h3 a")?.href === tickerLink.href, "Chart header uses the same trade link");
  click(document.querySelector('[aria-label="Close trade charts"]'));
  await section("Statistics");
  assert(document.querySelector('.tl-stats-tabs [aria-selected="true"]')?.textContent === "Overview", "Overview should open first");
  const chartTabs = [...document.querySelectorAll('.tl-stats-tabs [role="tab"]')].map(tab => tab.textContent);
  assert(chartTabs.indexOf("Tags") + 1 === chartTabs.indexOf("Symbols"), "Tags immediately precedes Symbols");
  await subtab("Distribution");
  await tooltip(document.querySelector('.tl-stats-tag-filter [value="any"]'), "at least one selected tag");
  await tooltip(document.querySelector('.tl-stats-tag-filter [value="all"]'), "every selected tag");
  await tooltip([...document.querySelectorAll(".tl-stats-controls .MuiTextField-root")].find(el => el.textContent?.includes("Bucket target")) ?? null, "Approximate number of result ranges");
  await dropdownTooltip("Result", "P&L $", "P&L % compares returns", false);
  await dropdownTooltip("Drill down by tag", "Untagged", "Refine the globally filtered trades", true);
  await dropdownTooltip("Tag source", "Trade tags", "Choose where to look for tags", true);
  await verifyLayout();
  const initialBuckets = [...document.querySelectorAll('.tl-stats-chart [role="button"]')].map(mark => mark.getAttribute("aria-label")?.split("\n")[0]);
  await subtab("Tags");
  const firstTag = document.querySelector('.tl-stats-chart [role="button"]');
  assert(firstTag, "Tag spreads rendered");
  firstTag.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  await pause();
  assert(document.querySelector('.tl-stats-tabs [aria-selected="true"]')?.textContent === "Distribution", "Tag drill-down stays in Statistics");
  assert(document.querySelector(".tl-stats-baseline"), "Baseline comparison visible");
  assert(JSON.stringify(initialBuckets) === JSON.stringify([...document.querySelectorAll('.tl-stats-chart [role="button"]')].map(mark => mark.getAttribute("aria-label")?.split("\n")[0])), "Tag drill-down changed buckets");
  await select("Drill down by tag", "Breakout");
  escape(); await pause();
  click(document.querySelector('.tl-stats-tag-filter [value="all"]'));
  await pause();
  const allCount = document.querySelector(".tl-stats-title .tl-caption")!.textContent;
  click(document.querySelector('.tl-stats-tag-filter [value="any"]')); await pause();
  const anyCount = document.querySelector(".tl-stats-title .tl-caption")!.textContent;
  assert(Number.parseInt(anyCount!) >= Number.parseInt(allCount!), "Any/all tag matching changed counts incorrectly");
  click([...document.querySelectorAll(".tl-stats-tag-filter button")].find(button => button.textContent === "Clear tags") ?? null);
  await pause();
  await select("Result", "P&L $");
  assert(document.querySelector('.tl-stats-chart svg')?.getAttribute("aria-label")?.includes("dollar"), "Dollar distribution switch");
  await select("Result", "P&L %");
  await verifyDrillLayout();
  const bin = [...document.querySelectorAll('.tl-stats-chart [role="button"]')].find(mark => !mark.getAttribute("aria-label")?.includes("\n0 trades"));
  click(bin ?? null); await pause();
  assert(document.querySelector(".tl-stats-drill table"), "Bucket drill-down shows trade list");
  assert(!document.querySelector(".tl-stats-drill .MuiPagination-root"), "Matching trades have no pagination");
  const initialRows = document.querySelectorAll(".tl-stats-drill tbody tr").length;
  const firstTradeLink = document.querySelector<HTMLAnchorElement>(".tl-stats-drill tbody a")!;
  const firstTradeHref = firstTradeLink.href;
  hiddenTradeId = Number(new URL(firstTradeHref).searchParams.get("trade_id"));
  assert(firstTradeLink.target === "_blank" && new URL(firstTradeHref).pathname === "/trade-logs", "Popup symbols open Trade Logs details in a new tab");
  window.addEventListener("click", event => event.preventDefault(), { capture: true, once: true });
  click(firstTradeLink); await pause();
  assert(document.querySelector(".tl-stats-drill"), "Opening a symbol preserves the distribution popup");
  assert(document.querySelector('.tl-tabs [aria-selected="true"]')?.textContent === "Statistics", "Popup symbol link does not switch to Trades");
  await new Promise(resolve => setTimeout(resolve, 300));
  window.dispatchEvent(new Event("focus"));
  await waitFor(() => document.querySelectorAll(".tl-stats-drill tbody tr").length === initialRows - 1, "open drill-down reflects deletion on refresh");
  assert(![...document.querySelectorAll<HTMLAnchorElement>(".tl-stats-drill tbody a")].some(link => link.href === firstTradeHref), "Deleted trade cannot be opened from the overlay");
  hiddenTradeId = null;
  await new Promise(resolve => setTimeout(resolve, 300));
  window.dispatchEvent(new Event("focus"));
  await waitFor(() => document.querySelectorAll(".tl-stats-drill tbody tr").length === initialRows, "open drill-down reflects newly matching trades on refresh");
  const open = window.open;
  let rowDestination = "";
  window.open = url => { rowDestination = String(url); return null; };
  try { click(document.querySelector(".tl-stats-drill tbody tr")); } finally { window.open = open; }
  assert(rowDestination.startsWith("/trade-logs?trade_id="), "Clicking a popup row opens Trade Logs details separately");
  assert(document.querySelector('.tl-tabs [aria-selected="true"]')?.textContent === "Statistics", "Popup row preserves the Statistics tab");
  click(document.querySelector('[aria-label="Close matching trades"]'));
  await section("Statistics");
  await subtab("Overview");
  const gradients = document.querySelectorAll(".tl-stats-chart linearGradient");
  const stops = [...gradients[0].querySelectorAll("stop")];
  assert(stops.length === 2 && stops[0].getAttribute("offset") === stops[1].getAttribute("offset") && stops[0].getAttribute("stop-color") === "var(--color-positive)" && stops[1].getAttribute("stop-color") === "var(--color-negative)", "Cumulative P&L switches green/red at zero");
  const areaStops = [...gradients[1].querySelectorAll("stop")];
  assert(Number(areaStops[0].getAttribute("stop-opacity")) > Number(areaStops[1].getAttribute("stop-opacity")) && Number(areaStops[3].getAttribute("stop-opacity")) > Number(areaStops[2].getAttribute("stop-opacity")), "Cumulative fill deepens away from zero in both directions");
  await select("Chart", "Drawdown");
  assert(document.querySelector('.tl-stats-chart svg')?.getAttribute("aria-label")?.includes("drawdown"), "Drawdown chart switch");
  for (const label of ["Avg Win", "Avg Loss"]) assert([...document.querySelectorAll(".tl-stats-summary .tl-metric")].some(metric => metric.querySelector("span")?.textContent === label && metric.querySelector(".tl-pnl-percent")), `${label} shows dollars and return percentage`);
  assert(!document.querySelector(".tl-stats-summary")?.textContent?.includes("Average trade"), "Remove Average Trade metric");
  await subtab("Timing"); await select("Group", "Month");
  assert(document.querySelector(".tl-stats-pagination"), "Month groups paginate");
  await subtab("Tags");
  const tagList = document.querySelector<HTMLElement>(".tl-stats-scroll-viewport")!;
  assert(tagList && tagList.scrollHeight > tagList.clientHeight, "Long tag lists scroll within available height");
  assert(!document.querySelector(".tl-stats-pagination"), "Tag charts have no pagination");
  tagList.scrollTop = tagList.scrollHeight;
  await pause();
  const lastTag = tagList.querySelector('.tl-stats-mark:last-child')!.getBoundingClientRect();
  assert(lastTag.bottom <= tagList.getBoundingClientRect().bottom + 1, "Last tag is reachable by scrolling");
  assert(document.querySelector(".tl-stats-group-axis")!.getBoundingClientRect().bottom <= innerHeight, "Chart scale remains visible while scrolling");
  await select("Minimum trades", "20");
  assert([...document.querySelectorAll('.tl-stats-chart [role="button"]')].every(mark => Number(mark.getAttribute("aria-label")?.match(/· (\d+) trades/)?.[1]) >= 20), "Sparse groups respect minimum sample count");
  await subtab("Symbols");
  const symbols = document.querySelector<HTMLElement>(".tl-stats-scroll-viewport")!;
  assert(symbols.querySelectorAll('[role="button"]').length === 15 && !document.querySelector(".tl-stats-pagination"), "All symbols render without pagination");
  symbols.scrollTop = symbols.scrollHeight;
  await pause();
  assert(symbols.scrollTop > 0, "Symbol list scrolls within available height");
  await subtab("Distribution");
  const ticker = document.querySelector<HTMLInputElement>('.tl-filters input');
  assert(ticker, "Global ticker filter");
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(ticker, "NVDA");
  ticker.dispatchEvent(new Event("input", { bubbles: true }));
  await waitFor(() => document.querySelector(".tl-stats-title .tl-caption")?.textContent === "8 / 8 closed trades", "global filters apply to statistics");
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(ticker, "");
  ticker.dispatchEvent(new Event("input", { bubbles: true }));
  await waitFor(() => document.querySelector(".tl-stats-title .tl-caption")?.textContent === "120 / 120 closed trades", "reset global filter");
  click(document.querySelector('.tl-stats-include-open input'));
  await waitFor(() => document.querySelector(".tl-stats-title .tl-caption")?.textContent === "122 / 122 trades · 2 open", "include daily-close-valued open trades");
  assert(document.querySelector(".tl-stats-footer")?.textContent?.includes("2026-10-21 – 2026-10-22"), "Open valuation dates visible");
  await subtab("Overview");
  const netStat = () => [...document.querySelectorAll(".tl-stats-summary .tl-metric")].find(metric => metric.querySelector("span")?.textContent === "Net P&L")?.querySelector("strong")?.textContent;
  const expectedNet = trades.reduce((sum, trade) => sum + Number(trade.summary.realized_pnl), 0) + 1600;
  assert(netStat() === new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(expectedNet), "Marked open P&L includes partial exits exactly once");
  for (const mode of ["missing", "stale", "error"] as const) {
    valuationMode = mode;
    await waitFor(() => !document.querySelector<HTMLButtonElement>('[aria-label="Refresh trade logs"]')?.disabled, "refresh enabled");
    click(document.querySelector('[aria-label="Refresh trade logs"]'));
    await waitFor(() => document.querySelector(".tl-stats-view .MuiAlert-root")?.textContent?.includes("Charts are withheld"), `withhold incomplete ${mode} prices`);
    assert(!document.querySelector(".tl-stats-chart"), "Do not plot partial or stale valuation totals");
    valuationMode = "valid";
    click([...document.querySelectorAll(".tl-stats-view button")].find(button => button.textContent === "Retry prices") ?? null);
    await waitFor(() => document.querySelector(".tl-stats-title .tl-caption")?.textContent === "122 / 122 trades · 2 open", "price retry recovery");
  }
  await subtab("Duration");
  await verifyDurationTradeLink(1001);
  await subtab("Distribution");
  assertFits();
  await verifyTagDescriptions();
  await section("Statistics");
  assert(errors.length === 0, `Browser errors: ${errors.join("; ")}`);
  return { passed: ["six chart tabs", "Any/All and control tooltips", "tag keyboard drill-down", "fixed comparison bins", "any/all tags", "dollar distribution", "bucket trade list", "read-only trade details", "drawdown", "average win/loss dollars and percentages", "monthly grouping", "pagination", "minimum sample count", "global filters", "open trade daily-close returns", "open partial-exit totals", "price date disclosure", "missing/stale/error price handling", "price retry recovery", "open trade drill-down"] };
}

async function verifyDurationTradeLink(id: number) {
  const link = document.querySelector<SVGAElement>(`.tl-stats-chart a[href="/trade-logs?trade_id=${id}"]`);
  assert(link, "Duration point is a native link to its trade");
  assert(link.getAttribute("target") === "_blank" && link.getAttribute("rel")?.includes("noopener"), "Duration trade opens safely in a new tab");
  assert(link.tabIndex === 0, "Duration trade link is keyboard accessible");
  window.addEventListener("click", event => event.preventDefault(), { capture: true, once: true });
  click(link);
  await pause();
  assert(document.querySelector('.tl-tabs [aria-selected="true"]')?.textContent === "Statistics", "Duration trade link preserves Statistics");
  assert(document.querySelector('.tl-stats-tabs [aria-selected="true"]')?.textContent === "Duration", "Duration trade link preserves the chart tab");
  assert(!document.querySelector(".tl-editor"), "Duration link does not open an editor");
}

async function verifyTagDescriptions() {
  await section("Tags");
  const button = (label: string) => [...document.querySelectorAll("button")].find(button => button.textContent === label) ?? null;
  const description = () => document.querySelector<HTMLTextAreaElement>('[role="dialog"] textarea:not([aria-hidden="true"])')!;
  const setText = (input: HTMLInputElement | HTMLTextAreaElement, value: string) => {
    const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const row = () => [...document.querySelectorAll(".tl-tags tbody tr")].find(row => row.querySelector("strong")?.textContent === "Review tag");
  const save = async () => { click(button("Save tag")); await waitFor(() => !document.querySelector('[role="dialog"]'), "save tag"); await waitFor(() => row(), "saved tag appears"); };
  click(button("Create tag")); await pause();
  assert(description().maxLength === 2000, "Description input has a length limit");
  setText(document.querySelector<HTMLInputElement>('[role="dialog"] input')!, "Review tag");
  await save();
  assert(tags.at(-1)?.description === null, "Description is optional");
  click(row()!.querySelector('[aria-label="Edit Review tag"]')); await pause();
  const text = "Entry after confirmation.\nAvoid chasing.";
  setText(description(), text);
  description().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  assert(document.querySelector('[role="dialog"]'), "Enter in multiline description does not save");
  await save();
  await waitFor(() => row()?.querySelector(".tl-tag-description")?.textContent === text, "description displayed in library");
  click(row()!.querySelector('[aria-label="Edit Review tag"]')); await pause();
  assert(description().value === text, "Description survives reopening the editor");
  setText(description(), " \n ");
  await save();
  await waitFor(() => row()?.querySelector(".tl-tag-description")?.textContent === "—", "description can be cleared");
  click(row()!.querySelector('[aria-label="Edit Review tag"]')); await pause();
  setText(description(), "Unsaved description");
  tags.at(-1)!.revision++;
  click(button("Save tag"));
  await waitFor(() => document.querySelector('[role="dialog"] [role="alert"]'), "stale tag error");
  assert(description().value === "Unsaved description", "Save error preserves description draft");
  click(button("Cancel")); await pause();
}

async function verifyLinkedTrade() {
  const id = Number(new URLSearchParams(location.search).get("trade_id"));
  await waitFor(() => !document.querySelector('.trade-logs-page[aria-busy="true"]'), "linked journal loaded");
  if (id === 404) {
    await waitFor(() => document.body.textContent?.includes("Trade not found"), "deleted trade error");
    assert(!document.querySelector(".tl-chart-drawer-paper .tl-trade-details"), "Deleted trade cannot display stale details");
    return { deletedTradeHandled: true };
  }
  await waitFor(() => document.querySelector(".tl-chart-drawer-paper .tl-trade-details"), "linked trade details");
  assert(document.querySelector('.tl-tabs [aria-selected="true"]')?.textContent === "Trades", "Deep link opens Trades");
  assert(document.querySelector(`.tl-trade-row.Mui-selected [aria-label$="trade ${id}"]`), "Linked trade's month expands and row is selected");
  assert(!document.querySelector(".tl-editor"), "Deep link opens read-only details");
  const row = document.querySelector(".tl-trade-row.Mui-selected")!.getBoundingClientRect();
  const container = document.querySelector(".tl-table-container")!.getBoundingClientRect();
  const header = document.querySelector(".tl-trades-table thead")!.getBoundingClientRect();
  assert(row.top >= header.bottom - 1 && row.bottom <= container.bottom + 1, `Selected row scrolls fully into view: ${row.top}–${row.bottom}, header ${header.bottom}, bottom ${container.bottom}`);
  const trade = allTrades.find(trade => trade.id === id)!;
  const month = new Date(`${trade.executions[0].market_date.slice(0, 7)}-15T12:00:00Z`).toLocaleDateString(undefined, { month: "long", year: "numeric" });
  click([...document.querySelectorAll(".tl-month-toggle")].find(toggle => toggle.textContent?.startsWith(month)) ?? null);
  await pause();
  assert(!document.querySelector(".tl-trade-row.Mui-selected"), "Selected month can still be collapsed manually");
  click(document.querySelector('[aria-label="Close trade charts"]'));
  await pause();
  assert(!document.querySelector(".tl-chart-drawer-paper .tl-trade-details"), "Linked chart can still be dismissed");
  await section("Statistics"); await subtab("Duration");
  await verifyDurationTradeLink(id);
  return { readOnlyTradeDeepLink: true, collapsedMonthRevealed: true, selectedRowVisible: true };
}
Object.assign(window, { tradeStatisticsTest: { runChecks, verifyLayout, verifyDrillLayout, verifyLinkedTrade, showTab: subtab } });
