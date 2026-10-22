import { TableCell, TableRow, Tooltip } from "@mui/material";
import KeyboardArrowDownIcon from "@mui/icons-material/KeyboardArrowDown";
import KeyboardArrowRightIcon from "@mui/icons-material/KeyboardArrowRight";
import type { TradeLog, TradeLogValuation } from "../../api/tradeLogs";
import { pnlClass } from "./format";
import { summarizeMonth } from "./monthlySummary";
import { PnlValue } from "./PnlValue";

export function TradeMonthRow({ month, trades, marks, expanded, onToggle }: {
  month: string; trades: TradeLog[]; marks: Map<number, TradeLogValuation>;
  expanded: boolean; onToggle: () => void;
}) {
  const summary = summarizeMonth(trades, marks);
  return <TableRow className="tl-month-row">
    <TableCell colSpan={4}>
      <button type="button" className="tl-month-toggle" aria-expanded={expanded} onClick={onToggle}>
        {expanded ? <KeyboardArrowDownIcon fontSize="small" /> : <KeyboardArrowRightIcon fontSize="small" />}
        {new Date(`${month}-15T12:00:00Z`).toLocaleDateString(undefined, { month: "long", year: "numeric" })}
        <span>{trades.length} {trades.length === 1 ? "trade" : "trades"}</span>
      </button>
    </TableCell>
    <TableCell align="right">
      <Tooltip title="Average winner / loser return for closed trades, after fees. Breakeven trades excluded.">
        <span className="tl-month-averages">
          <span className="tl-month-label">Avg</span>{" "}
          <span className="tl-positive">{summary.averageWin == null ? "—" : `+${summary.averageWin.toFixed(2)}%`}</span>
          {" / "}<span className="tl-negative">{summary.averageLoss == null ? "—" : `${summary.averageLoss.toFixed(2)}%`}</span>
        </span>
      </Tooltip>
    </TableCell>
    <MonthAmount value={summary.net} title="Realized + unrealized P&L for trades opened this month." />
    <MonthAmount value={summary.realized} title="Realized P&L after fees, including partial exits from open trades." />
    <MonthAmount value={summary.unrealized} title="Remaining positions valued at their latest completed daily close." />
    <MonthAmount value={summary.largestWin} returnPercent={summary.largestWinReturnPercent} label="Largest win" title="Largest net profit on a closed trade, after fees, with that trade’s return percentage." emptyTitle="No closed winning trades in this month and current filters." />
    <MonthAmount value={summary.largestLoss} returnPercent={summary.largestLossReturnPercent} label="Largest loss" title="Largest net loss on a closed trade, after fees, with that trade’s return percentage." emptyTitle="No closed losing trades in this month and current filters." />
    <TableCell colSpan={2} />
  </TableRow>;
}

function MonthAmount({ value, returnPercent, title, label, emptyTitle = "Unavailable: one or more open trades are missing a current valuation." }: {
  value: string | null; returnPercent?: number | null; title: string; label?: string; emptyTitle?: string;
}) {
  return <TableCell align="right" className={value == null ? "" : pnlClass(value)}>
    <Tooltip title={value == null ? emptyTitle : title}>
      <span>{label && <><span className="tl-month-label">{label}</span>{" "}</>}<PnlValue amount={value} returnPercent={returnPercent} /></span>
    </Tooltip>
  </TableCell>;
}
