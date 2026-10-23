import { useEffect, useMemo, useState } from "react";
import { Alert, Button, CircularProgress, IconButton, Tooltip } from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import EditOutlinedIcon from "@mui/icons-material/EditOutlined";
import OpenInFullIcon from "@mui/icons-material/OpenInFull";
import type { TradeLog } from "../../api/tradeLogs";
import { fetchMarketChartHistorySnapshot, maximumMarketChartHistoryDays, type MarketChartSnapshot } from "../../api/marketChart";
import { MarketChart } from "../charts/MarketChart";
import { errorMessage, shares } from "./format";
import { tradeChartRange } from "./chartHistoryRange";
import { dailyExecutionMarkers } from "./executionMarkers";
import { TradeTickerLink } from "./TradeTickerLink";
import "../charts/market-chart.css";

export function TradeLogChart({ trade, onSelect, onClose, onEdit, onExpand }: { trade: TradeLog; onSelect: (index: number) => void; onClose?: () => void; onEdit: () => void; onExpand?: () => void }) {
  const [result, setResult] = useState<{ key: string; data?: MarketChartSnapshot; error?: string } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [today] = useState(() => Date.now());
  const { start, end } = tradeChartRange(trade, today);
  const key = `${trade.symbol}/${start}/${end}/${attempt}`;
  const tooLong = Date.parse(end) - Date.parse(start) > maximumMarketChartHistoryDays * 86400000;
  useEffect(() => {
    if (!start || !end || tooLong) return;
    const controller = new AbortController();
    void fetchMarketChartHistorySnapshot(trade.symbol, "daily", start, end, { signal: controller.signal })
      .then(data => { if (!controller.signal.aborted) setResult({ key, data }); })
      .catch(error => { if (!controller.signal.aborted) setResult({ key, error: errorMessage(error) }); });
    return () => controller.abort();
  }, [trade.symbol, start, end, tooLong, key]);
  const data = result?.key === key ? result.data : undefined;
  const markers = useMemo(() => dailyExecutionMarkers(trade.executions), [trade.executions]);
  const missing = data ? markers.filter(marker => !data.candles.some(candle => candle.date === marker.date)).length : 0;
  return <section className="tl-chart-section tl-trade-view-section" aria-label="Execution chart">
    <div className="tl-section-heading"><h3><TradeTickerLink trade={trade} /> - Daily</h3>{onExpand && <Tooltip title="Open hourly chart overlay"><IconButton size="small" aria-label="Expand trade charts" onClick={onExpand}><OpenInFullIcon fontSize="small" /></IconButton></Tooltip>}<IconButton size="small" aria-label={`Edit ${trade.symbol} trade ${trade.id}`} onClick={onEdit}><EditOutlinedIcon fontSize="small" /></IconButton>{onClose && <IconButton size="small" aria-label="Close trade charts" onClick={onClose}><CloseIcon fontSize="small" /></IconButton>}</div>
    {tooLong ? <Alert severity="info">This trade exceeds the available chart history. Your executions can still be edited and saved.</Alert>
      : result?.key === key && result.error ? <Alert severity="info" action={<Button onClick={() => setAttempt(n => n + 1)}>Retry</Button>}>Chart unavailable. Your journal can still be saved.</Alert>
      : !data ? <div className="tl-chart-placeholder"><CircularProgress size={20} /> Loading chart</div>
      : !data.candles.length ? <Alert severity="info">No price history is available for this ticker and period.</Alert>
      : <><div className="tl-chart"><MarketChart data={data} relativeStrengthPlacement="hidden" dateMarkers={markers} onMarkerClick={id => onSelect(Number(id))} showCandleReadout /></div>
        <div className="tl-marker-legend">{trade.executions.map((leg, index) => <Button key={index} size="small" onClick={() => onSelect(index)} title={`${leg.action}: ${leg.quantity} shares at $${leg.price}`}><span className={leg.side === "buy" ? "tl-positive" : "tl-negative"}>{leg.action[0]}{index + 1}</span> {leg.action} {shares(leg.quantity)} @ {leg.price}</Button>)}<span className="tl-marker-hint">Trading dates · Select a marker to find its execution</span></div>
        {missing > 0 && <p className="tl-caption">{missing} execution(s) fall outside the returned trading candles. All executions appear below.</p>}</>}
  </section>;
}
