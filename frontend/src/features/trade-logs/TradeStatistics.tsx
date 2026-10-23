import { memo, useMemo, useState, type ReactNode } from "react";
import { Alert, Button, Checkbox, FormControlLabel, MenuItem, Pagination, Tab, Tabs, TextField, ToggleButton, ToggleButtonGroup } from "@mui/material";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import type { TradeLogSnapshot, TradeLogValuation } from "../../api/tradeLogs";
import { TradeFilterSelect } from "./TradeFilterSelect";
import { ControlTooltip } from "./ControlTooltip";
import { PnlValue } from "./PnlValue";
import { DurationChart, GroupChart, HistogramChart, PnlCurveChart, chartNumber, useChartSize } from "./StatisticsCharts";
import { StatisticsTradeList } from "./StatisticsTradeList";
import {
  statisticsPopulation, filterPointsByTags, histogram, histogramEdges, rankGroups, resolveStatisticsDrill, summarizePoints, symbolGroups,
  tagGroups, timingGroups, type RankingMetric, type ReturnMetric, type StatisticsDrill, type TagScope, type TradeGroup, type TradePoint,
} from "./statisticsData";
import { money, percent, pnlClass } from "./format";
import "./trade-statistics.css";

const tabs = ["Overview", "Distribution", "Timing", "Duration", "Tags", "Symbols"] as const;
type StatisticsTab = typeof tabs[number];
const rankingOptions: [RankingMetric, string][] = [["net", "Net P&L ($)"], ["median", "Median return (%)"], ["winRate", "Win rate (%)"], ["count", "Trade count"]];
const statHints: Record<string, string> = {
  "Net P&L": "Total profit minus losses and recorded fees. When open trades are included, their realized partial exits and unrealized P&L at the latest daily close are included.",
  "Win rate": "Trades with positive net P&L ÷ all included trades, including breakeven trades. When open trades are included, their outcomes are provisional at the latest daily close.",
  "Profit factor": "Total winning P&L ÷ absolute total losing P&L. Above 1 means profits exceed losses. Unavailable when there are no losses.",
  "Avg Win": "Average dollar profit and arithmetic mean percentage return of winning trades, after recorded fees. Each winner has equal weight. Included open positions use their latest daily close.",
  "Avg Loss": "Average dollar loss and arithmetic mean percentage return of losing trades, after recorded fees. Each loser has equal weight. Included open positions use their latest daily close.",
  "Median return": "The middle trade return: half the returns are lower, half higher. Less affected by extreme wins or losses than the mean.",
  "Mean return": "Arithmetic average of individual trade returns. Every included trade has equal weight, regardless of position size.",
  "Best return": "Highest individual return percentage after recorded fees. Open-trade outcomes are provisional when included.",
  "Worst return": "Lowest individual return percentage after recorded fees. Open-trade outcomes are provisional when included.",
  "Trades": "Number of trades matching the global filters and Statistics tag selection. Closed trades only unless Include open trades is enabled.",
  "Wins / losses / flat": "Counts of trades with positive, negative, or zero net P&L after recorded fees. Included open trades are classified at their latest daily close.",
};
const choiceHints: Record<string, string> = {
  "Statistics chart": "Switch between focused chart views. Your tag drill-down stays active across views.",
  "Result": "P&L % compares returns relative to gross entry notional. P&L $ shows the actual profit or loss. Both include fees.",
  "Frequency": "Share (%) shows each bucket as a percentage of its population. Trade count shows the number of trades in each bucket.",
  "Bucket target": "Approximate number of result ranges in the histogram. More buckets show finer detail. All trades, including outliers, remain included.",
  "Chart": "Cumulative P&L adds trade results over time. Drawdown shows the dollar decline from the highest daily cumulative P&L. Included open trades contribute one current daily-close valuation; historical unrealized P&L is not reconstructed.",
  "Measure": "Net P&L totals dollars; median return shows a typical trade; win rate measures winning frequency; trade count shows sample size. Return spread shows the middle 50%, median, and extremes.",
  "Minimum trades": "Hide groups with fewer included trades than this threshold. This changes the groups displayed, not the overall Statistics filters.",
  "Group": "Compare outcomes by the weekday or month of first entry, using the configured time zone.",
};

function Stat({ label, value, className = "" }: { label: string; value: ReactNode; className?: string }) {
  return <ControlTooltip title={statHints[label] ?? ""}><div className={`tl-metric ${className}`} tabIndex={0}><span>{label}</span><strong>{value}</strong></div></ControlTooltip>;
}
function Choice<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: readonly (readonly [T, string])[]; onChange: (value: T) => void }) {
  const [menuOpen, setMenuOpen] = useState(false);
  return <ControlTooltip title={choiceHints[label] ?? ""} disabled={menuOpen}><TextField select size="small" label={label} value={value} onChange={event => onChange(event.target.value as T)}
    slotProps={{ select: { onOpen: () => setMenuOpen(true), onClose: () => setMenuOpen(false) } }}>
    {options.map(([value, label]) => <MenuItem key={value} value={value}>{label}</MenuItem>)}
  </TextField></ControlTooltip>;
}

export const TradeStatistics = memo(function TradeStatistics({ snapshot, tagScope, marks, marksLoading, marketError, includeOpen, onIncludeOpen, onRetryPrices }: {
  snapshot: TradeLogSnapshot; tagScope: TagScope; marks: Map<number, TradeLogValuation>; marksLoading: boolean; marketError: string;
  includeOpen: boolean; onIncludeOpen: (value: boolean) => void; onRetryPrices: () => void;
}) {
  const [tab, setTab] = useState<StatisticsTab>("Overview");
  const [selectedTags, setSelectedTags] = useState<number[]>([]);
  const [match, setMatch] = useState<"any" | "all">("any");
  const [drill, setDrill] = useState<StatisticsDrill | null>(null);
  const population = useMemo(() => statisticsPopulation(snapshot.trades, snapshot.time_zone, includeOpen, marks), [snapshot.trades, snapshot.time_zone, includeOpen, marks]);
  const baseline = population.points;
  const incomplete = includeOpen && (population.unavailable.length > 0 || marketError !== "");
  const points = useMemo(() => filterPointsByTags(baseline, selectedTags, match, tagScope), [baseline, selectedTags, match, tagScope]);
  const stats = useMemo(() => summarizePoints(points), [points]);
  const drillGroup = drill ? resolveStatisticsDrill(points, drill) : null;
  const openCount = points.filter(point => point.mark !== null).length;
  const priceDates = [...new Set(points.flatMap(point => point.mark ? [point.mark.date] : []))].sort();
  const selectTag = (group: TradeGroup) => { setSelectedTags([Number(group.key)]); setTab("Distribution"); };
  const returnValue = (value: number | null) => value === null ? "—" : chartNumber(value, "percent");
  return <div className="tl-statistics tl-statistics-dashboard">
    <div className="tl-stats-toolbar">
      <div className="tl-stats-title"><h2>Performance</h2><span className="tl-caption">{incomplete ? marketError ? "Open-price refresh failed" : `${population.unavailable.length} open prices unavailable` : `${points.length} / ${baseline.length} ${includeOpen ? `trades · ${openCount} open` : "closed trades"}`}</span>
        <ControlTooltip title="Return % = net P&L ÷ gross entry notional. Each trade has equal weight in return statistics; this is not an account return. Global filters apply first; drill-down tags refine those results. Open trades are optional and use their latest completed daily close."><InfoOutlinedIcon fontSize="small" tabIndex={0} aria-label="Statistics calculation details" /></ControlTooltip>
        <ControlTooltip title="Include open positions at each ticker's latest completed trading-day close. P&L includes realized partial exits, remaining-position unrealized P&L, and recorded fees. Future exit fees are excluded. All included open positions need valid prices."><FormControlLabel className="tl-stats-include-open" control={<Checkbox size="small" checked={includeOpen} onChange={(_, checked) => onIncludeOpen(checked)} />} label="Include open trades" /></ControlTooltip>
      </div>
      <div className="tl-stats-tag-filter">
        <TradeFilterSelect label="Drill down by tag" hint="Refine the globally filtered trades using tags. Any matches at least one selected tag; All requires every selected tag. Untagged means no tags in the chosen tag source." values={selectedTags}
          options={[...snapshot.tags.map(tag => ({ value: tag.id, label: tag.name })), { value: 0, label: "Untagged" }]}
          onChange={setSelectedTags} />
        <ToggleButtonGroup size="small" exclusive value={match} onChange={(_, value: "any" | "all" | null) => { if (value) setMatch(value); }} aria-label="Tag matching">
          <ControlTooltip title="Include trades with at least one selected tag. For Breakout + Pullback, either tag is enough."><ToggleButton value="any">Any</ToggleButton></ControlTooltip>
          <ControlTooltip title="Include only trades with every selected tag. For Breakout + Pullback, both tags must be present."><ToggleButton value="all">All</ToggleButton></ControlTooltip>
        </ToggleButtonGroup>
        <Button size="small" disabled={!selectedTags.length} onClick={() => setSelectedTags([])}>Clear tags</Button>
      </div>
    </div>
    <Tabs className="tl-stats-tabs" value={tab} onChange={(_, value: StatisticsTab) => setTab(value)} variant="fullWidth" aria-label="Statistics charts">
      {tabs.map(label => <Tab key={label} label={label} value={label} id={`tl-stats-tab-${label}`} aria-controls="tl-stats-view" />)}
    </Tabs>
    <div className="tl-stats-mobile-nav"><Choice label="Statistics chart" value={tab} options={tabs.map(tab => [tab, tab] as const)} onChange={setTab} /></div>
    <div className="tl-stats-summary">
      {incomplete ? <p className="tl-caption">{marksLoading ? "Loading daily-close prices…" : "Statistics are unavailable until open-position prices can be verified."}</p> : tab === "Overview" ? <>
        <Stat label="Net P&L" value={money(String(stats.net))} className={pnlClass(String(stats.net))} />
        <Stat label="Win rate" value={percent(stats.winRate)} /><Stat label="Profit factor" value={stats.profitFactor?.toFixed(2) ?? "—"} />
        <Stat label="Avg Win" className="tl-positive" value={<PnlValue amount={stats.averageWinner === null ? null : String(stats.averageWinner)} returnPercent={stats.averageWinnerReturn} />} />
        <Stat label="Avg Loss" className="tl-negative" value={<PnlValue amount={stats.averageLoser === null ? null : String(stats.averageLoser)} returnPercent={stats.averageLoserReturn} />} />
        <Stat label="Wins / losses / flat" value={`${stats.winners} / ${stats.losers} / ${stats.breakeven}`} />
      </> : <>
        <Stat label="Trades" value={stats.count} /><Stat label="Median return" value={returnValue(stats.medianReturn)} /><Stat label="Mean return" value={returnValue(stats.meanReturn)} />
        <Stat label="Best return" value={returnValue(stats.maxReturn)} /><Stat label="Worst return" value={returnValue(stats.minReturn)} /><Stat label="Win rate" value={percent(stats.winRate)} />
      </>}
    </div>
    <section className="tl-stats-view" id="tl-stats-view" role="tabpanel" aria-labelledby={`tl-stats-tab-${tab}`}>
      {incomplete ? <><Alert severity={marksLoading ? "info" : "warning"} action={!marksLoading && <Button size="small" onClick={onRetryPrices}>Retry prices</Button>}>
        {marksLoading ? "Loading completed daily closes for open positions." : `${population.unavailable.length ? `${population.unavailable.length} open position(s) have no daily-close valuation valid for their latest executions. ` : ""}${marketError ? "Price refresh failed. " : ""}Charts are withheld to avoid incomplete totals. Retry or turn off Include open trades.`}
      </Alert><Empty>{population.unavailable.slice(0, 8).map(trade => `${trade.symbol} #${trade.id}`).join(", ")}{population.unavailable.length > 8 ? ` and ${population.unavailable.length - 8} more` : ""}</Empty></> : <>
      {tab === "Distribution" && <DistributionView points={points} baseline={baseline} filtered={selectedTags.length > 0} onDrill={setDrill} />}
      {tab === "Overview" && <OverviewView points={points} onGroup={group => setDrill({ label: group.label, kind: "endDate", value: group.key })} />}
      {tab === "Tags" && <RankedView key="tags" groups={tagGroups(points, snapshot.tags, tagScope)} tags onGroup={selectTag} />}
      {tab === "Timing" && <TimingView points={points} onDrill={setDrill} timeZone={snapshot.time_zone} />}
      {tab === "Duration" && <>
        <div className="tl-stats-chart-heading"><h3>Holding duration vs. return</h3><span className="tl-caption">One dot per trade · opens details in a new tab</span></div>
        {stats.returnCount ? <DurationChart points={points} /> : <Empty />}
        <p className="tl-stats-footnote">Elapsed holding time in days. Green = profit; red = loss. Trades with unavailable returns are excluded.{includeOpen && " Open positions use current elapsed duration and daily-close returns."}</p>
      </>}
      {tab === "Symbols" && <RankedView key="symbols" groups={symbolGroups(points)} onGroup={group => setDrill({ label: group.label, kind: "symbol", value: group.key })} />}
      </>}
    </section>
    <div className="tl-stats-footer"><span>Fees included · {stats.returnCount < points.length ? `${points.length - stats.returnCount} returns unavailable · ` : ""}Tag source: {tagScope.length === 1 ? tagScope[0] === "trade" ? "trade" : "execution" : "trade + execution"}</span>
      <ControlTooltip title={includeOpen ? "Open positions use the latest available completed daily candle for each ticker. Recorded fees and partial exits are included; future exit fees are excluded. Price dates may differ by ticker." : "Open positions and their realized partial exits are excluded. Enable Include open trades to value them at the latest daily close."}><span>{includeOpen ? priceDates.length ? `Open close prices: ${priceDates[0]}${priceDates.length > 1 ? ` – ${priceDates.at(-1)}` : ""} ⓘ` : "No open close prices" : `${snapshot.open_trades} open · ${money(snapshot.open_realized_pnl)} realized on open trades ⓘ`}</span></ControlTooltip></div>
    {drillGroup && <StatisticsTradeList group={drillGroup} unavailable={incomplete} onClose={() => setDrill(null)} />}
  </div>;
});

function Empty({ children = "No trades with available returns match these filters." }: { children?: ReactNode }) { return <div className="tl-stats-empty">{children}</div>; }

function DistributionView({ points, baseline, filtered, onDrill }: { points: TradePoint[]; baseline: TradePoint[]; filtered: boolean; onDrill: (drill: StatisticsDrill) => void }) {
  const [metric, setMetric] = useState<ReturnMetric>("return");
  const [binCount, setBinCount] = useState("20");
  const [frequency, setFrequency] = useState<"share" | "count">("share");
  const [compare, setCompare] = useState(true);
  const edges = useMemo(() => histogramEdges(baseline, metric, Number(binCount)), [baseline, metric, binCount]);
  const bins = useMemo(() => histogram(points, metric, edges), [points, metric, edges]);
  const baseBins = useMemo(() => histogram(baseline, metric, edges), [baseline, metric, edges]);
  const count = bins.reduce((sum, bin) => sum + bin.points.length, 0);
  return <>
    <div className="tl-stats-chart-heading"><h3>Outcome distribution</h3><div className="tl-stats-controls">
      <Choice label="Result" value={metric} options={[["return", "P&L %"], ["pnl", "P&L $"]]} onChange={setMetric} />
      <Choice label="Frequency" value={frequency} options={[["share", "Share (%)"], ["count", "Trade count"]]} onChange={setFrequency} />
      <Choice label="Bucket target" value={binCount} options={[["10", "10"], ["20", "20"], ["30", "30"]]} onChange={setBinCount} />
      {filtered && <ControlTooltip title="Outline bars show all trades matching the global filters; filled bars show your selected tags. In Share (%) mode, each population totals 100% independently."><FormControlLabel control={<Checkbox size="small" checked={compare} onChange={(_, checked) => setCompare(checked)} />} label="Compare to all" /></ControlTooltip>}
    </div></div>
    {edges.length > 0 && (count > 0 || filtered && compare) ? <HistogramChart bins={bins} baseline={baseBins} metric={metric} share={frequency === "share"} compare={filtered && compare} onBin={bin => onDrill({
      kind: "bucket", metric, lower: bin.lower, upper: bin.upper, includesUpper: bin.includesUpper,
      label: `${chartNumber(bin.lower, metric === "return" ? "percent" : "money")} ≤ result ${bin.includesUpper ? "≤" : "<"} ${chartNumber(bin.upper, metric === "return" ? "percent" : "money")}`,
    })} /> : <Empty />}
    <p className="tl-stats-footnote">{filtered && compare ? <><span className="tl-stats-legend-base" /> All filtered trades <span className="tl-stats-legend-selection" /> Selected tags · </> : null}Select a bucket to inspect trades. Buckets stay fixed while drilling into tags.{frequency === "share" && " Each population is normalized separately."}</p>
  </>;
}

function OverviewView({ points, onGroup }: { points: TradePoint[]; onGroup: (group: TradeGroup) => void }) {
  const [mode, setMode] = useState<"pnl" | "drawdown">("pnl");
  const hasOpen = points.some(point => point.mark !== null);
  return <>
    <div className="tl-stats-chart-heading"><h3>{mode === "pnl" ? `Cumulative ${hasOpen ? "trade" : "closed-trade"} P&L` : `${hasOpen ? "Marked-trade" : "Closed-trade"} drawdown`}</h3><Choice label="Chart" value={mode} options={[["pnl", "Cumulative P&L"], ["drawdown", "Drawdown"]]} onChange={setMode} /></div>
    {points.length ? <PnlCurveChart points={points} drawdown={mode === "drawdown"} onGroup={onGroup} /> : <Empty />}
    <p className="tl-stats-footnote">Closed trades book on final exit. {hasOpen ? "Open trades contribute once on their price date; historical unrealized P&L is not reconstructed. " : "Open positions are excluded. "}Drawdown uses this daily P&L series, starting at $0.</p>
  </>;
}

function RankedView({ groups, tags = false, onGroup }: { groups: TradeGroup[]; tags?: boolean; onGroup: (group: TradeGroup) => void }) {
  const [mode, setMode] = useState<RankingMetric | "spread">(tags ? "spread" : "net");
  const [minimum, setMinimum] = useState("1");
  const metric = mode === "spread" ? "median" : mode;
  const ranked = rankGroups(groups.filter(group => group.points.length >= Number(minimum)), metric);
  return <>
    <div className="tl-stats-chart-heading"><h3>{tags ? "Performance by tag" : "Performance by symbol"}</h3><div className="tl-stats-controls">
      <Choice label="Measure" value={mode} options={tags ? [["spread", "Return spread (%)"], ...rankingOptions] : rankingOptions} onChange={setMode} />
      <Choice label="Minimum trades" value={minimum} options={[["1", "1"], ["5", "5"], ["10", "10"], ["20", "20"]]} onChange={setMinimum} />
    </div></div>
    {ranked.length ? <GroupChart key={`${mode}:${minimum}`} groups={ranked} metric={metric} spread={mode === "spread"} scrollable onGroup={onGroup} /> : <Empty>No groups meet the selected filters and minimum trade count.</Empty>}
    <p className="tl-stats-footnote">{tags ? `${mode === "spread" ? "Whiskers: min/max; box: middle 50%; line: median. " : ""}Select a tag to drill into its distribution. A trade counts once per tag; groups overlap and are not additive.` : "Ranked highest first. Select a symbol to inspect its trades."}</p>
  </>;
}

function TimingView({ points, onDrill, timeZone }: { points: TradePoint[]; onDrill: (drill: StatisticsDrill) => void; timeZone: string }) {
  const [mode, setMode] = useState<"weekday" | "month">("weekday");
  const [metric, setMetric] = useState<RankingMetric>("net");
  const groups = timingGroups(points, mode);
  return <>
    <div className="tl-stats-chart-heading"><h3>Performance by entry date</h3><div className="tl-stats-controls">
      <Choice label="Group" value={mode} options={[["weekday", "Weekday"], ["month", "Month"]]} onChange={setMode} />
      <Choice label="Measure" value={metric} options={rankingOptions} onChange={setMetric} />
    </div></div>
    {points.length ? <PagedGroups key={`${mode}:${metric}`} groups={groups} metric={metric} onGroup={group => onDrill({ label: group.label, kind: mode === "weekday" ? "entryWeekday" : "entryMonth", value: group.key })} /> : <Empty />}
    <p className="tl-stats-footnote">Grouped by first entry in {timeZone}. Includes full trade outcomes{points.some(point => point.mark) ? " and marked open-position returns" : ""}. Select a group to inspect trades.</p>
  </>;
}

function PagedGroups({ groups, metric, onGroup }: { groups: TradeGroup[]; metric: RankingMetric; onGroup: (group: TradeGroup) => void }) {
  const [page, setPage] = useState(1);
  const { ref, size } = useChartSize();
  const pageSize = Math.max(1, Math.min(12, Math.floor((size.height - 90) / 42)));
  const pages = Math.max(1, Math.ceil(groups.length / pageSize));
  const current = Math.min(page, pages);
  return <div className="tl-stats-group-stage" ref={ref}>
    <GroupChart groups={groups.slice((current - 1) * pageSize, current * pageSize)} metric={metric} spread={false} onGroup={onGroup} />
    <div className="tl-stats-pagination"><span className="tl-caption">{(current - 1) * pageSize + 1}–{Math.min(current * pageSize, groups.length)} of {groups.length}</span><Pagination size="small" count={pages} page={current} onChange={(_, page) => setPage(page)} siblingCount={0} /></div>
  </div>;
}
