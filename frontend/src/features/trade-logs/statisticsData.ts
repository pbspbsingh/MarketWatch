import type { TradeLog, TradeLogFilters, TradeLogTag, TradeLogValuation } from "../../api/tradeLogs";

export type TagScope = TradeLogFilters["tag_scope"];
export type ReturnMetric = "return" | "pnl";
export type RankingMetric = "net" | "median" | "winRate" | "count";
export interface TradePoint {
  trade: TradeLog;
  pnl: number;
  pnlCash: string;
  returnPercent: number | null;
  durationDays: number;
  entryDate: string;
  endDate: string;
  mark: { price: string; date: string } | null;
}
export interface TradeGroup { key: string; label: string; points: TradePoint[] }
export interface HistogramBin { lower: number; upper: number; includesUpper: boolean; points: TradePoint[] }
export type StatisticsDrill = { label: string } & (
  | { kind: "bucket"; metric: ReturnMetric; lower: number; upper: number; includesUpper: boolean }
  | { kind: "symbol" | "entryMonth" | "entryWeekday" | "endDate"; value: string }
);

function inBucket(value: number, bin: Pick<HistogramBin, "lower" | "upper" | "includesUpper">): boolean {
  return value >= bin.lower && (value < bin.upper || bin.includesUpper && value <= bin.upper);
}

const weekdayKey = (point: TradePoint) => String((new Date(`${point.entryDate}T12:00:00Z`).getUTCDay() + 6) % 7);

/** Store drill criteria, not data snapshots, so refreshes keep the overlay current. */
export function resolveStatisticsDrill(points: TradePoint[], drill: StatisticsDrill): TradeGroup {
  return { key: drill.label, label: drill.label, points: points.filter(point => {
    if (drill.kind === "bucket") {
      const value = pointValue(point, drill.metric);
      return value !== null && inBucket(value, drill);
    }
    if (drill.kind === "symbol") return point.trade.symbol === drill.value;
    if (drill.kind === "entryMonth") return point.entryDate.slice(0, 7) === drill.value;
    if (drill.kind === "entryWeekday") return weekdayKey(point) === drill.value;
    return point.endDate === drill.value;
  }) };
}

export function closedTradePoints(trades: TradeLog[], timeZone: string): TradePoint[] {
  const date = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  return trades.filter(trade => trade.summary.status === "closed" && trade.summary.closed_at !== null).map(trade => ({
    trade, pnl: Number(trade.summary.realized_pnl), pnlCash: trade.summary.realized_pnl,
    returnPercent: trade.summary.net_return_percent != null && Number.isFinite(trade.summary.net_return_percent) ? trade.summary.net_return_percent : null,
    durationDays: Math.max(0, (Date.parse(trade.summary.closed_at!) - Date.parse(trade.summary.opened_at)) / 86_400_000),
    entryDate: date.format(new Date(trade.summary.opened_at)),
    endDate: date.format(new Date(trade.summary.closed_at!)), mark: null,
  }));
}

/** Open outcomes come from the server's fee-aware, latest-completed-close valuation. */
export function statisticsPopulation(trades: TradeLog[], timeZone: string, includeOpen: boolean, marks: Map<number, TradeLogValuation>, now = Date.now()) {
  const points = closedTradePoints(trades, timeZone);
  const unavailable: TradeLog[] = [];
  const date = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  if (includeOpen) for (const trade of trades.filter(trade => trade.summary.status === "open")) {
    const mark = marks.get(trade.id);
    const lastExecutionDate = trade.executions.at(-1)?.market_date;
    if (!mark || mark.revision !== trade.revision || !mark.mark_date || !mark.mark_price || !Number.isFinite(Number(mark.mark_price)) || Number(mark.mark_price) <= 0
      || mark.total_pnl === null || !Number.isFinite(Number(mark.total_pnl)) || mark.net_return_percent === null || !Number.isFinite(mark.net_return_percent)
      || lastExecutionDate && mark.mark_date < lastExecutionDate) { unavailable.push(trade); continue; }
    points.push({ trade, pnl: Number(mark.total_pnl), pnlCash: mark.total_pnl, returnPercent: mark.net_return_percent,
      entryDate: date.format(new Date(trade.summary.opened_at)), endDate: mark.mark_date,
      durationDays: Math.max(0, (now - Date.parse(trade.summary.opened_at)) / 86_400_000),
      mark: { price: mark.mark_price, date: mark.mark_date },
    });
  }
  return { points, unavailable };
}

export function tradeTagIds(trade: TradeLog, scope: TagScope): Set<number> {
  return new Set([
    ...(!scope.length || scope.includes("trade") ? trade.tag_ids : []),
    ...(!scope.length || scope.includes("leg") ? trade.executions.flatMap(leg => leg.tag_ids) : []),
  ]);
}

export function filterPointsByTags(points: TradePoint[], ids: number[], match: "any" | "all", scope: TagScope): TradePoint[] {
  if (!ids.length) return points;
  return points.filter(point => {
    const tags = tradeTagIds(point.trade, scope);
    const matches = (id: number) => id === 0 ? tags.size === 0 : tags.has(id);
    return match === "all" ? ids.every(matches) : ids.some(matches);
  });
}

/** Linear interpolation between adjacent order statistics; input must be sorted. */
export function quantile(sorted: number[], fraction: number): number | null {
  if (!sorted.length) return null;
  const index = (sorted.length - 1) * fraction;
  const lower = Math.floor(index);
  return sorted[lower] + (sorted[Math.ceil(index)] - sorted[lower]) * (index - lower);
}

// The API emits cash with at most six decimal places. Accumulate those units
// exactly, then convert for display/plotting; offsetting trades must total zero.
function pnlMicros(point: TradePoint): bigint {
  const value = point.pnlCash;
  const negative = value.startsWith("-");
  const [integer, fraction = ""] = (negative ? value.slice(1) : value).split(".");
  const micros = BigInt(integer) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
  return negative ? -micros : micros;
}
const cashNumber = (micros: bigint) => Number(micros) / 1_000_000;

export function summarizePoints(points: TradePoint[]) {
  let net = 0n, grossProfit = 0n, grossLoss = 0n, winners = 0, losers = 0;
  let winnerReturns = 0, loserReturns = 0, winnerReturnCount = 0, loserReturnCount = 0;
  const returns: number[] = [];
  for (const point of points) {
    const pnl = pnlMicros(point);
    net += pnl;
    if (pnl > 0n) { winners++; grossProfit += pnl; }
    if (pnl < 0n) { losers++; grossLoss -= pnl; }
    if (point.returnPercent !== null) {
      returns.push(point.returnPercent);
      if (pnl > 0n) { winnerReturns += point.returnPercent; winnerReturnCount++; }
      if (pnl < 0n) { loserReturns += point.returnPercent; loserReturnCount++; }
    }
  }
  returns.sort((a, b) => a - b);
  return {
    count: points.length, net: cashNumber(net), winners, losers, breakeven: points.length - winners - losers,
    averageWinner: winners ? cashNumber(grossProfit) / winners : null,
    averageLoser: losers ? -cashNumber(grossLoss) / losers : null,
    averageWinnerReturn: winnerReturnCount ? winnerReturns / winnerReturnCount : null,
    averageLoserReturn: loserReturnCount ? loserReturns / loserReturnCount : null,
    winRate: points.length ? winners / points.length * 100 : null,
    profitFactor: grossLoss > 0n ? Number(grossProfit) / Number(grossLoss) : null,
    meanReturn: returns.length ? returns.reduce((sum, value) => sum + value, 0) / returns.length : null,
    medianReturn: quantile(returns, 0.5),
    minReturn: returns.at(0) ?? null, maxReturn: returns.at(-1) ?? null,
    returnCount: returns.length,
  };
}

export const pointValue = (point: TradePoint, metric: ReturnMetric): number | null => metric === "return" ? point.returnPercent : point.pnl;

/** The baseline defines shared buckets, so tag comparisons never change their meaning. */
export function histogramEdges(points: TradePoint[], metric: ReturnMetric, targetBins: number): number[] {
  let min = Infinity, max = -Infinity;
  for (const point of points) {
    const value = pointValue(point, metric);
    if (value !== null) { min = Math.min(min, value); max = Math.max(max, value); }
  }
  if (!Number.isFinite(min)) return [];
  if (min === max) { const padding = Math.max(Math.abs(min) * 0.05, 1); min -= padding; max += padding; }
  const rawStep = (max - min) / targetBins;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const step = Math.max(Math.ceil(rawStep / magnitude) * magnitude, Number.EPSILON * Math.max(Math.abs(min), Math.abs(max)));
  const lowerIndex = Math.floor(min / step);
  const lower = lowerIndex * step;
  const count = Math.max(1, Math.ceil((max - lower) / step));
  const edges = Array.from({ length: count + 1 }, (_, i) => (lowerIndex + i) * step);
  edges[0] = Math.min(edges[0], min);
  edges[edges.length - 1] = Math.max(edges.at(-1)!, max);
  return edges;
}

export function histogram(points: TradePoint[], metric: ReturnMetric, edges: number[]): HistogramBin[] {
  const bins = edges.slice(1).map((upper, i) => ({ lower: edges[i], upper, includesUpper: i === edges.length - 2, points: [] as TradePoint[] }));
  for (const point of points) {
    const value = pointValue(point, metric);
    if (value === null) continue;
    const bin = bins.find(bin => inBucket(value, bin));
    bin?.points.push(point);
  }
  return bins;
}

export function tagGroups(points: TradePoint[], tags: TradeLogTag[], scope: TagScope): TradeGroup[] {
  const names = new Map(tags.map(tag => [tag.id, tag.name]));
  const groups = new Map<number, TradePoint[]>();
  for (const point of points) for (const id of tradeTagIds(point.trade, scope)) {
    const group = groups.get(id) ?? [];
    group.push(point); groups.set(id, group);
  }
  const untagged = points.filter(point => tradeTagIds(point.trade, scope).size === 0);
  if (untagged.length) { groups.set(0, untagged); names.set(0, "Untagged"); }
  return [...groups].map(([id, points]) => ({ key: String(id), label: names.get(id) ?? `Tag #${id}`, points }));
}

export function symbolGroups(points: TradePoint[]): TradeGroup[] {
  return groupPoints(points, point => point.trade.symbol).map(([label, points]) => ({ key: label, label, points }));
}

function groupPoints(points: TradePoint[], key: (point: TradePoint) => string): [string, TradePoint[]][] {
  const groups = new Map<string, TradePoint[]>();
  for (const point of points) { const value = key(point); const group = groups.get(value) ?? []; group.push(point); groups.set(value, group); }
  return [...groups].sort(([a], [b]) => a.localeCompare(b));
}

export function timingGroups(points: TradePoint[], mode: "weekday" | "month"): TradeGroup[] {
  if (mode === "month") return groupPoints(points, point => point.entryDate.slice(0, 7)).map(([key, points]) => ({
    key, label: new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${key}-01T12:00:00Z`)), points,
  }));
  const days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  return days.map((label, i) => ({ key: String(i), label, points: points.filter(point => weekdayKey(point) === String(i)) }));
}

export function rankingValue(points: TradePoint[], metric: RankingMetric): number | null {
  const stats = summarizePoints(points);
  return metric === "net" ? stats.net : metric === "median" ? stats.medianReturn : metric === "winRate" ? stats.winRate : stats.count;
}

export function rankGroups(groups: TradeGroup[], metric: RankingMetric): TradeGroup[] {
  return groups.map(group => ({ group, value: rankingValue(group.points, metric) ?? -Infinity }))
    .sort((a, b) => b.value - a.value || a.group.label.localeCompare(b.group.label)).map(({ group }) => group);
}

/** Closed results book on final exit; open positions contribute one current close-price snapshot. */
export function tradePnlCurve(points: TradePoint[]) {
  let cumulative = 0n, peak = 0n;
  return groupPoints(points, point => point.endDate).map(([date, points]) => {
    cumulative += points.reduce((sum, point) => sum + pnlMicros(point), 0n);
    if (cumulative > peak) peak = cumulative;
    return { date, points, cumulative: cashNumber(cumulative), drawdown: cashNumber(cumulative - peak) };
  });
}
