import { Fragment, useState } from "react";
import { Button, Chip, IconButton, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, TableSortLabel, Tooltip } from "@mui/material";
import EditOutlinedIcon from "@mui/icons-material/EditOutlined";
import type { TradeLog, TradeLogTag, TradeLogValuation } from "../../api/tradeLogs";
import { localDate, money, pnlClass, shares } from "./format";
import { TradeMonthRow } from "./TradeMonthRow";

type SortColumn = "opened" | "symbol" | "side" | "status" | "return" | "net" | "realized" | "unrealized" | "quantity" | "tags";
const columns: { key: SortColumn | "entry"; label: string; numeric?: boolean }[] = [
  { key: "opened", label: "Opened" }, { key: "symbol", label: "Ticker" }, { key: "side", label: "Side" }, { key: "status", label: "Status" },
  { key: "return", label: "Gain / loss %", numeric: true }, { key: "net", label: "Net P&L", numeric: true },
  { key: "realized", label: "Realized", numeric: true }, { key: "unrealized", label: "Unrealized", numeric: true },
  { key: "entry", label: "Avg. entry", numeric: true }, { key: "quantity", label: "Open shares", numeric: true }, { key: "tags", label: "Tags" },
];

export function TradeTable({ trades, tags, marks, selectedId, loading, onSelect, onEdit }: {
  trades: TradeLog[]; tags: TradeLogTag[]; marks: Map<number, TradeLogValuation>;
  selectedId: number | null; loading: boolean; onSelect: (trade: TradeLog) => void; onEdit: (trade: TradeLog) => void;
}) {
  const [sort, setSort] = useState<{ column: SortColumn; direction: "asc" | "desc" }>({ column: "opened", direction: "desc" });
  const [expandedMonths, setExpandedMonths] = useState<Record<string, boolean>>({});
  const rows = trades.map(trade => {
    const open = trade.summary.status === "open";
    const cached = marks.get(trade.id);
    const mark = cached?.revision === trade.revision ? cached : undefined;
    return {
      trade, open, mark,
      quantity: trade.direction === "short" && trade.summary.remaining_quantity !== "0" ? `-${trade.summary.remaining_quantity}` : trade.summary.remaining_quantity,
      net: open ? mark?.total_pnl ?? null : trade.summary.realized_pnl,
      roi: open ? mark?.net_return_percent ?? null : trade.summary.net_return_percent,
      tags: tags.filter(tag => trade.tag_ids.includes(tag.id)).map(tag => tag.name).join(", "),
      status: open ? "Open" : Number(trade.summary.realized_pnl) > 0 ? "Win" : Number(trade.summary.realized_pnl) < 0 ? "Loss" : "BE",
    };
  });
  type Row = typeof rows[number];
  const value = (row: Row): string | number | null => {
    switch (sort.column) {
      case "opened": return Date.parse(row.trade.summary.opened_at);
      case "symbol": return row.trade.symbol;
      case "side": return row.trade.direction;
      case "status": return row.status;
      case "return": return row.roi;
      case "net": return row.net === null ? null : Number(row.net);
      case "realized": return Number(row.trade.summary.realized_pnl);
      case "unrealized": return row.open && row.mark?.unrealized_pnl != null ? Number(row.mark.unrealized_pnl) : null;
      case "quantity": return Number(row.quantity);
      case "tags": return row.tags;
    }
  };
  rows.sort((a, b) => {
    const left = value(a), right = value(b);
    if (left == null) return right == null ? b.trade.id - a.trade.id : 1;
    if (right == null) return -1;
    const order = typeof left === "number" && typeof right === "number" ? left - right : String(left).localeCompare(String(right));
    return order * (sort.direction === "asc" ? 1 : -1) || b.trade.id - a.trade.id;
  });
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const key = sort.column === "opened" ? row.trade.executions[0].market_date.slice(0, 7) : "";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(row);
  }
  const latestMonth = [...groups.keys()].reduce((latest, month) => month > latest ? month : latest, "");
  const isMonthExpanded = (month: string) => expandedMonths[month] ?? month === latestMonth;
  const toggleMonth = (month: string) => setExpandedMonths(current => ({
    ...current, [month]: !(current[month] ?? month === latestMonth),
  }));
  return <TableContainer className="tl-table-container">
    <Table stickyHeader size="small" className="tl-trades-table" aria-label="Trade journal">
      <TableHead><TableRow>
        {columns.map(({ key, label, numeric }) => <TableCell key={key} align={numeric ? "right" : "left"} sortDirection={sort.column === key ? sort.direction : false}>
          {key === "entry" ? label : <TableSortLabel active={sort.column === key} direction={sort.column === key ? sort.direction : "asc"} onClick={() => setSort(current => ({ column: key, direction: current.column === key ? current.direction === "asc" ? "desc" : "asc" : "asc" }))}>{label}</TableSortLabel>}
        </TableCell>)}<TableCell />
      </TableRow></TableHead>
      <TableBody>
        {[...groups].map(([month, monthRows]) => <Fragment key={month}>
          {month && <TradeMonthRow month={month} trades={monthRows.map(row => row.trade)} marks={marks} expanded={isMonthExpanded(month)} onToggle={() => toggleMonth(month)} />}
          {(!month || isMonthExpanded(month)) && monthRows.map(({ trade, open, mark, net, roi, quantity, tags: names, status }) => {
            const priceInfo = open ? mark?.mark_date ? `Valued at $${mark.mark_price}, daily close on ${mark.mark_date}. Includes recorded fees; future exit fees excluded.` : "Daily valuation unavailable or awaiting a completed close after the last execution." : "Final result after recorded fees.";
            return <TableRow key={trade.id} hover selected={selectedId === trade.id} className="tl-trade-row" onClick={() => onSelect(trade)}>
              <TableCell><Button className="tl-date-link" size="small" aria-label={`View charts for ${trade.symbol} trade ${trade.id}`} aria-expanded={selectedId === trade.id} onClick={event => { event.stopPropagation(); onSelect(trade); }}>{localDate(trade.summary.opened_at)}</Button></TableCell>
              <TableCell><strong>{trade.symbol}</strong></TableCell><TableCell className="tl-direction">{trade.direction}</TableCell><TableCell><Chip size="small" variant="outlined" label={status} className={open ? "" : pnlClass(trade.summary.realized_pnl)} /></TableCell>
              <TableCell align="right" className={`tl-return ${roi == null ? "" : pnlClass(String(roi))}`}><Tooltip title={`${priceInfo} Net P&L / total entry value × 100; shorts use sell-entry value, without margin assumptions.`}><span>{roi == null ? "—" : `${roi > 0 ? "+" : ""}${roi.toFixed(2)}%`}</span></Tooltip></TableCell>
              <TableCell align="right" className={`tl-return ${net === null ? "" : pnlClass(net)}`}><Tooltip title={priceInfo}><span>{money(net)}</span></Tooltip></TableCell>
              <TableCell align="right" className={pnlClass(trade.summary.realized_pnl)}>{money(trade.summary.realized_pnl)}</TableCell>
              <TableCell align="right" className={mark?.unrealized_pnl ? pnlClass(mark.unrealized_pnl) : ""}><Tooltip title={priceInfo}><span>{open ? money(mark?.unrealized_pnl) : "—"}</span></Tooltip></TableCell>
              <TableCell align="right">{money(trade.summary.average_entry_price)}</TableCell><TableCell align="right">{shares(quantity)}</TableCell>
              <TableCell><span className="tl-table-tags" title={names}>{names || "—"}</span></TableCell>
              <TableCell><IconButton size="small" aria-label={`Edit ${trade.symbol} trade ${trade.id}`} onClick={event => { event.stopPropagation(); onEdit(trade); }}><EditOutlinedIcon fontSize="small" /></IconButton></TableCell>
            </TableRow>;
          })}
        </Fragment>)}
        {!trades.length && <TableRow><TableCell colSpan={columns.length + 1} className="tl-empty-small">{loading ? "Loading trades…" : "No trades to display. Create a trade or adjust your filters."}</TableCell></TableRow>}
      </TableBody>
    </Table>
  </TableContainer>;
}
