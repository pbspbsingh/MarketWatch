import { useId } from "react";
import { Button, Dialog, DialogContent, DialogTitle, IconButton } from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import type { TradeLog } from "../../api/tradeLogs";
import { summarizePoints, type TradeGroup } from "./statisticsData";
import { chartNumber } from "./StatisticsCharts";
import { money, pnlClass } from "./format";

export function StatisticsTradeList({ group, unavailable = false, onClose, onOpenTrade }: { group: TradeGroup; unavailable?: boolean; onClose: () => void; onOpenTrade: (trade: TradeLog) => void }) {
  const titleId = useId();
  const rows = [...group.points].sort((a, b) => b.endDate.localeCompare(a.endDate) || b.trade.id - a.trade.id);
  const net = String(summarizePoints(group.points).net);
  return <Dialog open onClose={onClose} fullWidth maxWidth="md" aria-labelledby={titleId}
    slotProps={{ paper: { className: "trade-logs-ui tl-stats-drill" } }}>
    <DialogTitle component="div">
      <div><h2 id={titleId}>{group.label}</h2><div className="tl-stats-drill-meta">{unavailable ? <span>Awaiting verified daily-close prices</span> : <><span>{rows.length} {rows.length === 1 ? "trade" : "trades"}</span><span>Net P&L <strong className={pnlClass(net)}>{money(net)}</strong></span></>}</div></div>
      <IconButton size="small" aria-label="Close matching trades" onClick={onClose}><CloseIcon fontSize="small" /></IconButton>
    </DialogTitle>
    <DialogContent>
      {unavailable ? <div className="tl-empty-small">Open-position prices are unavailable. Close this list to retry prices.</div> : rows.length > 0 ? <div className="tl-stats-drill-table">
        <table aria-label="Matching trades"><thead><tr><th>Trade</th><th>Closed / priced</th><th>Side</th><th>Net P&L</th><th>Return</th></tr></thead><tbody>
          {rows.map(point => <tr key={point.trade.id} onClick={() => onOpenTrade(point.trade)}>
            <td><Button size="small" onClick={event => { event.stopPropagation(); onOpenTrade(point.trade); }} aria-label={`View ${point.trade.symbol} trade ${point.trade.id}`}>{point.trade.symbol} <span className="tl-caption">#{point.trade.id}</span></Button>{point.mark && <span className="tl-stats-drill-open">open</span>}</td>
            <td title={point.mark ? `Open · daily close $${point.mark.price} on ${point.mark.date}` : `Closed ${point.endDate}`}><time dateTime={point.endDate}>{point.endDate}</time></td><td>{point.trade.direction}</td>
            <td className={pnlClass(point.pnlCash)} title={money(point.pnlCash)}>{money(point.pnlCash)}</td>
            <td className={pnlClass(point.pnlCash)}>{point.returnPercent === null ? "—" : chartNumber(point.returnPercent, "percent")}</td>
          </tr>)}
        </tbody></table>
      </div> : <div className="tl-empty-small">No trades in this range.</div>}
    </DialogContent>
  </Dialog>;
}
