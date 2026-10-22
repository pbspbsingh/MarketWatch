import { useState } from "react";
import { Button, Drawer, IconButton } from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import type { TradeLog } from "../../api/tradeLogs";
import { TradeLogChart } from "./TradeLogChart";
import { TradeHourlyChart } from "./TradeHourlyChart";
import { localDateTime, shares } from "./format";

export function TradeChartDrawer({ trade, onClose, onEdit }: { trade: TradeLog | null; onClose: () => void; onEdit: (trade: TradeLog) => void }) {
  return <Drawer anchor="right" variant="persistent" open={trade !== null} className="tl-chart-drawer" slotProps={{ paper: { className: "trade-logs-ui tl-chart-drawer-paper" } }}>
    {trade && <DrawerContents key={trade.id} trade={trade} onClose={onClose} onEdit={onEdit} />}
  </Drawer>;
}
function DrawerContents({ trade, onClose, onEdit }: { trade: TradeLog; onClose: () => void; onEdit: (trade: TradeLog) => void }) {
  const [selected, setSelected] = useState<number | null>(null);
  const leg = selected === null ? null : trade.executions[selected];
  return <>
    <header className="tl-drawer-header"><strong>{trade.symbol}</strong><span className="tl-direction">{trade.direction}</span><Button size="small" onClick={() => onEdit(trade)}>Edit trade</Button><IconButton size="small" aria-label="Close trade charts" onClick={onClose}><CloseIcon fontSize="small" /></IconButton></header>
    <div className="tl-drawer-charts"><TradeLogChart trade={trade} onSelect={setSelected} /><TradeHourlyChart trade={trade} onSelect={setSelected} /></div>
    {leg && <div className="tl-marker-detail">{leg.action} · {leg.side} {shares(leg.quantity)} @ {leg.price} · {localDateTime(leg.executed_at).replace("T", " ")}{leg.notes && <p>{leg.notes}</p>}</div>}
  </>;
}
