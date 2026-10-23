import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { Tooltip } from "@mui/material";
import {
  tradePnlCurve, quantile, rankingValue, type HistogramBin, type RankingMetric,
  type ReturnMetric, type TradeGroup, type TradePoint,
} from "./statisticsData";

const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const decimal = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const smallDecimal = new Intl.NumberFormat("en-US", { maximumSignificantDigits: 3 });
export const chartNumber = (value: number, unit: "money" | "percent" | "number" = "number") =>
  `${value < 0 ? "−" : ""}${unit === "money" ? "$" : ""}${Math.abs(value) >= 1000 ? compact.format(Math.abs(value)) : Math.abs(value) > 0 && Math.abs(value) < 0.01 ? smallDecimal.format(Math.abs(value)) : decimal.format(Math.abs(value))}${unit === "percent" ? "%" : ""}`;
const color = (value: number) => value < 0 ? "var(--color-negative)" : "var(--color-positive)";

export function useChartSize() {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 800, height: 300 });
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (width > 0 && height > 0) setSize(current => current.width === width && current.height === height ? current : { width, height });
    });
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  return { ref, size };
}

function ChartFrame({ label, children }: { label: string; children: (width: number, height: number) => ReactNode }) {
  const { ref, size } = useChartSize();
  return <ChartTooltip containerRef={ref}>
    <svg viewBox={`0 0 ${size.width} ${size.height}`} role="group" aria-label={label}>{children(size.width, size.height)}</svg>
  </ChartTooltip>;
}

// One delegated tooltip per plot; its hover state does not rerender the plotted marks.
function ChartTooltip({ containerRef, children }: { containerRef: RefObject<HTMLDivElement | null>; children: ReactNode }) {
  const [tip, setTip] = useState<{ anchor: SVGElement; label: string } | null>(null);
  const anchor = tip?.anchor ?? null;
  useEffect(() => {
    const container = containerRef.current;
    if (!anchor || !container) return;
    // Refresh the active label or dismiss a removed mark after a background data update.
    const observer = new MutationObserver(() => setTip(current => {
      if (!current || current.anchor !== anchor) return current;
      if (!anchor.isConnected) return null;
      const label = anchor.getAttribute("aria-label") ?? "";
      return current.label === label ? current : { anchor, label };
    }));
    observer.observe(container, { subtree: true, childList: true, attributes: true, attributeFilter: ["aria-label"] });
    return () => observer.disconnect();
  }, [anchor, containerRef]);
  const show = (target: EventTarget | null) => {
    const next = target instanceof Element ? target.closest<SVGElement>(".tl-stats-mark") : null;
    setTip(current => current?.anchor === next ? current : next ? { anchor: next, label: next.getAttribute("aria-label") ?? "" } : null);
  };
  return <Tooltip title={<span style={{ whiteSpace: "pre-line" }}>{tip?.label}</span>}
    open={tip !== null} arrow placement="top" disableInteractive disableHoverListener disableFocusListener disableTouchListener
    slotProps={{ popper: { anchorEl: anchor } }}>
    <div className="tl-stats-chart" ref={containerRef} onMouseOver={event => show(event.target)} onMouseLeave={() => setTip(null)}
      onFocus={event => show(event.target)} onBlur={() => setTip(null)} onPointerDown={() => setTip(null)} onKeyDown={() => setTip(null)}>
      {children}
    </div>
  </Tooltip>;
}

function Mark({ label, onClick, href, children }: { label: string; children: ReactNode } & ({ onClick: () => void; href?: never } | { href: string; onClick?: never })) {
  return href !== undefined ? <a className="tl-stats-mark" href={href} target="_blank" rel="noopener noreferrer" tabIndex={0} aria-label={label}>{children}</a>
      : <g className="tl-stats-mark" role="button" tabIndex={0} aria-label={label} onClick={onClick}
        onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onClick(); } }}>{children}</g>;
}

function domain(values: (number | null)[], includeZero = true): [number, number] {
  let min = includeZero ? 0 : Infinity, max = includeZero ? 0 : -Infinity;
  for (const value of values) if (value !== null && Number.isFinite(value)) { min = Math.min(min, value); max = Math.max(max, value); }
  if (!Number.isFinite(min)) return [-1, 1];
  if (min === max) return [min - 1, max + 1];
  return [min, max];
}
const scale = (value: number, [min, max]: [number, number], start: number, end: number) => start + (value - min) / (max - min) * (end - start);

function YAxis({ range, height, width, unit }: { range: [number, number]; height: number; width: number; unit: "money" | "percent" | "number" }) {
  return <>{Array.from({ length: 5 }, (_, index) => {
    const value = range[0] + (range[1] - range[0]) * index / 4;
    const y = scale(value, range, height - 35, 22);
    return <g key={index}><line className="tl-stats-gridline" x1={70} x2={width - 20} y1={y} y2={y} /><text x={60} y={y + 4} textAnchor="end">{chartNumber(value, unit)}</text></g>;
  })}</>;
}

export function HistogramChart({ bins, baseline, metric, share, compare, onBin }: {
  bins: HistogramBin[]; baseline: HistogramBin[]; metric: ReturnMetric; share: boolean; compare: boolean; onBin: (bin: HistogramBin) => void;
}) {
  const total = bins.reduce((sum, bin) => sum + bin.points.length, 0);
  const baseTotal = baseline.reduce((sum, bin) => sum + bin.points.length, 0);
  const value = (count: number, countTotal: number) => share ? countTotal ? count / countTotal * 100 : 0 : count;
  const max = Math.max(1, ...bins.map(bin => value(bin.points.length, total)), ...(compare ? baseline.map(bin => value(bin.points.length, baseTotal)) : [])) * 1.1;
  const unit = metric === "return" ? "percent" : "money";
  return <ChartFrame label={`Distribution of net ${metric === "return" ? "return percent" : "dollar P&L"}`}>
    {(width, height) => {
      if (!bins.length) return null;
      const left = 70, right = width - 20, bottom = height - 35;
      const range: [number, number] = [bins[0].lower, bins.at(-1)!.upper];
      const x = (v: number) => scale(v, range, left, right);
      const y = (v: number) => scale(v, [0, max], bottom, 22);
      const tickEvery = Math.max(1, Math.ceil(bins.length / Math.max(2, Math.floor((right - left) / 85))));
      return <>
        <YAxis range={[0, max]} width={width} height={height} unit={share ? "percent" : "number"} />
        {bins.map((bin, i) => {
          const count = bin.points.length, amount = value(count, total), baselineAmount = value(baseline[i]?.points.length ?? 0, baseTotal);
          const label = `${chartNumber(bin.lower, unit)} ≤ result ${bin.includesUpper ? "≤" : "<"} ${chartNumber(bin.upper, unit)}\n${count} trades · ${chartNumber(total ? count / total * 100 : 0, "percent")} of selection`;
          return <g key={i}>
            {compare && <rect className="tl-stats-baseline" x={x(bin.lower) + 1} y={y(baselineAmount)} width={Math.max(1, x(bin.upper) - x(bin.lower) - 2)} height={bottom - y(baselineAmount)} />}
            <Mark label={label} onClick={() => onBin(bin)}>
              <rect fill={color(bin.upper <= 0 ? -1 : 1)} opacity={0.8} x={x(bin.lower) + (compare ? 4 : 2)} y={y(amount)} width={Math.max(1, x(bin.upper) - x(bin.lower) - (compare ? 8 : 4))} height={bottom - y(amount)} />
              <rect fill="transparent" x={x(bin.lower)} y={22} width={Math.max(1, x(bin.upper) - x(bin.lower))} height={Math.max(1, bottom - 22)} />
            </Mark>
            {i % tickEvery === 0 && <text x={x(bin.lower)} y={height - 13} textAnchor="middle">{chartNumber(bin.lower, unit)}</text>}
          </g>;
        })}
        <text x={right} y={height - 13} textAnchor="end">{chartNumber(range[1], unit)}</text>
        {range[0] <= 0 && range[1] >= 0 && <line className="tl-stats-zero" x1={x(0)} x2={x(0)} y1={17} y2={bottom} />}
        <text x={left} y={13}>{share ? "Share of trades (%)" : "Number of trades"}</text>
      </>;
    }}
  </ChartFrame>;
}

export function PnlCurveChart({ points, drawdown, onGroup }: { points: TradePoint[]; drawdown: boolean; onGroup: (group: TradeGroup) => void }) {
  const gradientId = useId();
  const areaGradientId = `${gradientId}-area`;
  const curve = tradePnlCurve(points);
  const hasOpen = points.some(point => point.mark !== null);
  return <ChartFrame label={drawdown ? `Daily ${hasOpen ? "marked-trade" : "closed-trade"} drawdown in dollars` : `Cumulative ${hasOpen ? "marked-trade" : "closed-trade"} net P&L in dollars`}>
    {(width, height) => {
      if (!curve.length) return null;
      const data = [{ date: new Date(Date.parse(`${curve[0].date}T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10), cumulative: 0, drawdown: 0, points: [] }, ...curve];
      const times = data.map(point => Date.parse(`${point.date}T12:00:00Z`));
      const range = domain(data.map(point => drawdown ? point.drawdown : point.cumulative));
      const x = (index: number) => scale(times[index], [times[0], times.at(-1)!], 70, width - 20);
      const y = (point: typeof data[number]) => scale(drawdown ? point.drawdown : point.cumulative, range, height - 35, 22);
      const path = data.map((point, i) => `${i ? "L" : "M"}${x(i)},${y(point)}`).join(" ");
      const zeroY = scale(0, range, height - 35, 22);
      const zeroOffset = Math.max(0, Math.min(1, (zeroY - 22) / Math.max(1, height - 57)));
      const stroke = drawdown ? "var(--color-negative)" : `url(#${gradientId})`;
      const step = Math.max(1, Math.ceil((data.length - 1) / Math.max(2, Math.floor(width / 150))));
      return <>
        <defs>
          <linearGradient id={gradientId} gradientUnits="userSpaceOnUse" x1={0} y1={22} x2={0} y2={height - 35}>
            <stop offset={zeroOffset} stopColor="var(--color-positive)" /><stop offset={zeroOffset} stopColor="var(--color-negative)" />
          </linearGradient>
          <linearGradient id={areaGradientId} gradientUnits="userSpaceOnUse" x1={0} y1={22} x2={0} y2={height - 35}>
            <stop offset={0} stopColor="var(--color-positive)" stopOpacity={0.32} />
            <stop offset={zeroOffset} stopColor="var(--color-positive)" stopOpacity={0.02} />
            <stop offset={zeroOffset} stopColor="var(--color-negative)" stopOpacity={0.02} />
            <stop offset={1} stopColor="var(--color-negative)" stopOpacity={0.32} />
          </linearGradient>
        </defs>
        <YAxis range={range} width={width} height={height} unit="money" />
        <line className="tl-stats-zero" x1={70} x2={width - 20} y1={scale(0, range, height - 35, 22)} y2={scale(0, range, height - 35, 22)} />
        <path d={`${path} L${width - 20},${zeroY} L70,${zeroY} Z`} fill={`url(#${areaGradientId})`} />
        <path d={path} fill="none" stroke={stroke} strokeWidth={2} />
        {data.map((point, i) => <g key={point.date}>
          {point.points.length > 0 && <Mark label={`${point.date}\n${drawdown ? "Drawdown" : "Cumulative P&L"}: ${chartNumber(drawdown ? point.drawdown : point.cumulative, "money")}\n${point.points.length} trades ${point.points.some(point => point.mark) ? "closed or marked" : "closed"}`} onClick={() => onGroup({ key: point.date, label: `${hasOpen ? "Closed / marked" : "Closed"} ${point.date}`, points: point.points })}>
            <circle cx={x(i)} cy={y(point)} r={3} fill={drawdown || point.cumulative < 0 ? "var(--color-negative)" : "var(--color-positive)"} /><circle cx={x(i)} cy={y(point)} r={9} fill="transparent" />
          </Mark>}
          {(i % step === 0 || i === data.length - 1) && <text x={x(i)} y={height - 12} textAnchor={i === data.length - 1 ? "end" : i === 0 ? "start" : "middle"}>{point.date}</text>}
        </g>)}
      </>;
    }}
  </ChartFrame>;
}

export function GroupChart({ groups, metric, spread, scrollable = false, onGroup }: { groups: TradeGroup[]; metric: RankingMetric; spread: boolean; scrollable?: boolean; onGroup: (group: TradeGroup) => void }) {
  const { ref: scrollRef, size: viewport } = useChartSize();
  const unit = spread || metric === "median" || metric === "winRate" ? "percent" : metric === "net" ? "money" : "number";
  const returnValues = (group: TradeGroup) => group.points.flatMap(point => point.returnPercent === null ? [] : [point.returnPercent]).sort((a, b) => a - b);
  const range: [number, number] = !spread && metric === "winRate" ? [0, 100] : !spread && metric === "count" ? [0, Math.max(1, ...groups.map(group => group.points.length))]
    : domain(spread ? groups.flatMap(group => { const values = returnValues(group); return [values.at(0) ?? null, values.at(-1) ?? null]; }) : groups.map(group => rankingValue(group.points, metric)));
  const axis = (width: number, y: number) => Array.from({ length: 5 }, (_, i) => {
    const value = range[0] + (range[1] - range[0]) * i / 4;
    return <text key={i} x={scale(value, range, Math.min(180, width * 0.28), width - 70)} y={y} textAnchor="middle">{chartNumber(value, unit)}</text>;
  });
  const plot = (width: number, height: number) => {
      const left = Math.min(180, width * 0.28), right = width - 70, bottom = height - (scrollable ? 12 : 33);
      const x = (v: number) => scale(v, range, left, right);
      const rowHeight = Math.min(55, (bottom - 22) / Math.max(1, groups.length));
      const maxLabel = Math.max(7, Math.floor((left - 22) / 6.3));
      return <>
        {Array.from({ length: 5 }, (_, i) => {
          const value = range[0] + (range[1] - range[0]) * i / 4;
          return <line key={i} className="tl-stats-gridline" x1={x(value)} x2={x(value)} y1={15} y2={bottom} />;
        })}
        {!scrollable && axis(width, height - 12)}
        <line className="tl-stats-zero" x1={x(0)} x2={x(0)} y1={15} y2={bottom} />
        {groups.map((group, index) => {
          const y = 22 + rowHeight * (index + 0.5);
          const value = rankingValue(group.points, metric);
          const values = spread ? returnValues(group) : [];
          const [min, q1, median, q3, max] = [0, 0.25, 0.5, 0.75, 1].map(q => quantile(values, q));
          const label = `${group.label} · ${group.points.length} trades\n${spread ? min === null ? "Return unavailable" : `Min ${chartNumber(min, "percent")} · Q1 ${chartNumber(q1!, "percent")} · Median ${chartNumber(median!, "percent")} · Q3 ${chartNumber(q3!, "percent")} · Max ${chartNumber(max!, "percent")}` : value === null ? "Unavailable" : chartNumber(value, unit)}`;
          return <Mark key={group.key} label={label} onClick={() => onGroup(group)}>
            <rect x={0} y={y - rowHeight / 2} width={width} height={Math.max(1, rowHeight)} fill="transparent" />
            <text x={left - 14} y={y + 4} textAnchor="end">{group.label.length > maxLabel ? `${group.label.slice(0, maxLabel - 1)}…` : group.label}</text>
            {spread ? min !== null && <>
              <line x1={x(min)} x2={x(max!)} y1={y} y2={y} stroke="var(--accent-blue)" />
              {[min, max!].map((v, i) => <line key={i} x1={x(v)} x2={x(v)} y1={y - 6} y2={y + 6} stroke="var(--accent-blue)" />)}
              <rect x={x(q1!)} y={y - 10} width={Math.max(1, x(q3!) - x(q1!))} height={20} fill="var(--accent-blue)" opacity={0.25} />
              <line x1={x(median!)} x2={x(median!)} y1={y - 11} y2={y + 11} stroke="var(--accent-blue)" strokeWidth={3} />
            </> : value !== null && <rect x={Math.min(x(0), x(value))} y={y - 10} width={Math.max(1, Math.abs(x(value) - x(0)))} height={20} fill={metric === "count" || metric === "winRate" ? "var(--accent-blue)" : color(value)} opacity={0.8} />}
            <text x={right + 12} y={y + 4}>{group.points.length} trades</text>
          </Mark>;
        })}
      </>;
  };
  const label = spread ? "Net return percentage spread by tag" : `Performance by group: ${metric}`;
  if (!scrollable) return <ChartFrame label={label}>{plot}</ChartFrame>;
  return <div className="tl-stats-scroll-groups">
    <div className="tl-stats-scroll-viewport" ref={scrollRef} tabIndex={0} role="region" aria-label="Scrollable performance groups">
      <div className="tl-stats-scroll-canvas" style={{ height: Math.max(viewport.height, groups.length * 42 + 36) }}>
        <ChartFrame label={label}>{plot}</ChartFrame>
      </div>
    </div>
    <svg className="tl-stats-group-axis" style={{ width: viewport.width }} viewBox={`0 0 ${viewport.width} 28`} role="img" aria-label="Performance scale">{axis(viewport.width, 18)}</svg>
  </div>;
}

export function DurationChart({ points }: { points: TradePoint[] }) {
  const valid = points.filter(point => point.returnPercent !== null);
  const returns = domain(valid.map(point => point.returnPercent));
  const durations: [number, number] = [0, valid.reduce((max, point) => Math.max(max, point.durationDays), 1)];
  return <ChartFrame label="Holding duration in days versus net return percentage">
    {(width, height) => <>
      <YAxis range={returns} width={width} height={height} unit="percent" />
      <line className="tl-stats-zero" x1={70} x2={width - 20} y1={scale(0, returns, height - 35, 22)} y2={scale(0, returns, height - 35, 22)} />
      {Array.from({ length: 5 }, (_, i) => {
        const value = durations[0] + (durations[1] - durations[0]) * i / 4;
        return <text key={i} x={scale(value, durations, 70, width - 20)} y={height - 12} textAnchor={i === 4 ? "end" : "middle"}>{chartNumber(value)}d</text>;
      })}
      {valid.map(point => <Mark key={point.trade.id} href={`/trade-logs?trade_id=${point.trade.id}`} label={`${point.trade.symbol} #${point.trade.id}${point.mark ? " · open" : ""}\n${chartNumber(point.durationDays)} days · ${chartNumber(point.returnPercent!, "percent")}\nNet P&L ${chartNumber(point.pnl, "money")}${point.mark ? `\nDaily close $${point.mark.price} on ${point.mark.date}` : ""}\nOpen trade in a new tab`}>
        <circle cx={scale(point.durationDays, durations, 70, width - 20)} cy={scale(point.returnPercent!, returns, height - 35, 22)} r={5} fill={color(point.pnl)} opacity={0.65} />
        <circle cx={scale(point.durationDays, durations, 70, width - 20)} cy={scale(point.returnPercent!, returns, height - 35, 22)} r={9} fill="transparent" />
      </Mark>)}
    </>}
  </ChartFrame>;
}
