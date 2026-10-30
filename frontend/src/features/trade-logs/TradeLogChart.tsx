import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Alert, Button, CircularProgress, IconButton, Tooltip } from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import EditOutlinedIcon from "@mui/icons-material/EditOutlined";
import OpenInFullIcon from "@mui/icons-material/OpenInFull";
import type { TradeLog } from "../../api/tradeLogs";
import { MarketChart } from "../charts/MarketChart";
import { shares } from "./format";
import { tradeDailyChartQueryOptions, tradeChartRangeTooLong } from "./tradeChartQuery";
import { tradeChartRange } from "./chartHistoryRange";
import { dailyExecutionMarkers } from "./executionMarkers";
import { TradeTickerLink } from "./TradeTickerLink";
import "../charts/market-chart.css";

export function TradeLogChart({ trade, onSelect, onClose, onEdit, onExpand }: { trade: TradeLog; onSelect: (index: number) => void; onClose?: () => void; onEdit: () => void; onExpand?: () => void }) {
  const [today] = useState(() => Date.now());
  const { start, end } = tradeChartRange(trade, today);
  const tooLong = tradeChartRangeTooLong(start, end);
  const query = useQuery(tradeDailyChartQueryOptions({ symbol: trade.symbol, start, end }));
  const data = query.data;
  const markers = useMemo(() => dailyExecutionMarkers(trade.executions), [trade.executions]);
  const missing = data ? markers.filter(marker => !data.candles.some(candle => candle.date === marker.date)).length : 0;
  return <section className="tl-chart-section tl-trade-view-section" aria-label="Execution chart">
    <div className="tl-section-heading"><h3><TradeTickerLink trade={trade} /> - Daily</h3>{onExpand && <Tooltip title="Open hourly chart overlay"><IconButton size="small" aria-label="Expand trade charts" onClick={onExpand}><OpenInFullIcon fontSize="small" /></IconButton></Tooltip>}<IconButton size="small" aria-label={`Edit ${trade.symbol} trade ${trade.id}`} onClick={onEdit}><EditOutlinedIcon fontSize="small" /></IconButton>{onClose && <IconButton size="small" aria-label="Close trade charts" onClick={onClose}><CloseIcon fontSize="small" /></IconButton>}</div>
    {query.isError && data !== undefined && <Alert severity="info" action={<Button onClick={() => { void query.refetch(); }}>Retry</Button>}>Could not refresh daily prices. Showing cached data.</Alert>}
    {tooLong ? <Alert severity="info">This trade exceeds the available chart history. Your executions can still be edited and saved.</Alert>
      : query.isError && data === undefined ? <Alert severity="info" action={<Button onClick={() => { void query.refetch(); }}>Retry</Button>}>Chart unavailable. Your journal can still be saved.</Alert>
      : !data ? <div className="tl-chart-placeholder"><CircularProgress size={20} /> Loading chart</div>
      : !data.candles.length ? <Alert severity="info">No price history is available for this ticker and period.</Alert>
      : <><div className="tl-chart"><MarketChart key={`${trade.symbol}/${start}/${end}`} data={data} dateMarkers={markers} onMarkerClick={id => onSelect(Number(id))} showCandleReadout /></div>
        <div className="tl-marker-legend">{trade.executions.map((leg, index) => <Button key={index} size="small" onClick={() => onSelect(index)} title={`${leg.action}: ${leg.quantity} shares at $${leg.price}`}><span className={leg.side === "buy" ? "tl-positive" : "tl-negative"}>{leg.action[0]}{index + 1}</span> {leg.action} {shares(leg.quantity)} @ {leg.price}</Button>)}<span className="tl-marker-hint">Trading dates · Select a marker to find its execution</span></div>
        {missing > 0 && <p className="tl-caption">{missing} execution(s) fall outside the returned trading candles. All executions appear below.</p>}</>}
  </section>;
}
