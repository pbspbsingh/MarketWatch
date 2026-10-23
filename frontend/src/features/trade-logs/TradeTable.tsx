import { memo, useCallback, useMemo, useState, type KeyboardEvent } from "react";
import { Button, Chip, IconButton, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, TableSortLabel, Tooltip } from "@mui/material";
import EditOutlinedIcon from "@mui/icons-material/EditOutlined";
import type { TradeLog, TradeLogTag, TradeLogValuation } from "../../api/tradeLogs";
import { localDate, money, pnlClass, shares } from "./format";
import { TradeMonthRow } from "./TradeMonthRow";
import { TradeTickerLink } from "./TradeTickerLink";
import { useTradeTableWindow } from "./useTradeTableWindow";

type SortColumn = "opened" | "symbol" | "side" | "status" | "return" | "net" | "realized" | "unrealized" | "quantity" | "size" | "tags";
const columns: { key: SortColumn | "entry"; label: string; numeric?: boolean }[] = [
  { key: "opened", label: "Opened" }, { key: "symbol", label: "Ticker" }, { key: "side", label: "Side" }, { key: "status", label: "Status" },
  { key: "return", label: "Gain / loss %", numeric: true }, { key: "net", label: "Net P&L", numeric: true },
  { key: "realized", label: "Realized", numeric: true }, { key: "unrealized", label: "Unrealized", numeric: true },
  { key: "entry", label: "Avg. entry", numeric: true }, { key: "quantity", label: "Open shares", numeric: true },
  { key: "size", label: "Position size", numeric: true }, { key: "tags", label: "Tags", numeric: true },
];

type TradeRowData = {
  trade: TradeLog; open: boolean; mark: TradeLogValuation | undefined; quantity: string;
  net: string | null; roi: number | null; size: number; tags: string[]; status: string;
};
type TableItem = { kind: "month"; key: string; month: string; trades: TradeLog[]; expanded: boolean }
  | { kind: "trade"; key: string; row: TradeRowData };

export const TradeTable = memo(function TradeTable({ trades, tags, marks, selectedId, loading, onSelect, onEdit }: {
  trades: TradeLog[]; tags: TradeLogTag[]; marks: Map<number, TradeLogValuation>;
  selectedId: number | null; loading: boolean; onSelect: (trade: TradeLog) => void; onEdit: (trade: TradeLog) => void;
}) {
  const [sort, setSort] = useState<{ column: SortColumn; direction: "asc" | "desc" }>({ column: "opened", direction: "desc" });
  const [expandedMonths, setExpandedMonths] = useState<Record<string, boolean>>({});
  const [revealedTradeId, setRevealedTradeId] = useState<number | null>(null);
  const selectedMonth = trades.find(trade => trade.id === selectedId)?.executions[0]?.market_date.slice(0, 7);
  // Reveal each new selection before committing the row and scrolling to it.
  if (selectedId !== revealedTradeId && (selectedId === null || selectedMonth !== undefined)) {
    setRevealedTradeId(selectedId);
    if (selectedMonth && expandedMonths[selectedMonth] !== true) setExpandedMonths(current => ({ ...current, [selectedMonth]: true }));
  }
  const rows = useMemo(() => {
    const rows = trades.map(trade => {
      const open = trade.summary.status === "open";
      const cached = marks.get(trade.id);
      const mark = cached?.revision === trade.revision ? cached : undefined;
      return {
        trade, open, mark,
        quantity: trade.direction === "short" && trade.summary.remaining_quantity !== "0" ? `-${trade.summary.remaining_quantity}` : trade.summary.remaining_quantity,
        net: open ? mark?.total_pnl ?? null : trade.summary.realized_pnl,
        roi: open ? mark?.net_return_percent ?? null : trade.summary.net_return_percent,
        size: Number(trade.summary.average_entry_price) * Number(trade.summary.remaining_quantity),
        tags: tags.filter(tag => trade.tag_ids.includes(tag.id)).map(tag => tag.name),
        status: open ? "Open" : Number(trade.summary.realized_pnl) > 0 ? "Win" : Number(trade.summary.realized_pnl) < 0 ? "Loss" : "BE",
      };
    });
    const value = (row: TradeRowData): string | number | null => {
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
        case "size": return row.size;
        case "tags": return row.tags.length;
      }
    };
    rows.sort((a, b) => {
      const left = value(a), right = value(b);
      if (left == null) return right == null ? b.trade.id - a.trade.id : 1;
      if (right == null) return -1;
      const order = typeof left === "number" && typeof right === "number" ? left - right : String(left).localeCompare(String(right));
      return order * (sort.direction === "asc" ? 1 : -1) || b.trade.id - a.trade.id;
    });
    return rows;
  }, [trades, tags, marks, sort]);
  const groups = useMemo(() => {
    const result = new Map<string, TradeRowData[]>();
    for (const row of rows) {
      const key = sort.column === "opened" ? row.trade.executions[0].market_date.slice(0, 7) : "";
      if (!result.has(key)) result.set(key, []);
      result.get(key)!.push(row);
    }
    return result;
  }, [rows, sort.column]);
  const latestMonth = [...groups.keys()].reduce((latest, month) => month > latest ? month : latest, "");
  const items = useMemo(() => {
    const result: TableItem[] = [];
    for (const [month, monthRows] of groups) {
      const expanded = expandedMonths[month] ?? month === latestMonth;
      if (month) result.push({ kind: "month", key: `month:${month}`, month, expanded, trades: monthRows.map(row => row.trade) });
      if (!month || expanded) for (const row of monthRows) result.push({ kind: "trade", key: `trade:${row.trade.id}`, row });
    }
    return result;
  }, [groups, expandedMonths, latestMonth]);
  const { containerRef, tableRef, columns: columnWidths, onScroll, start, end, before, after } = useTradeTableWindow(items, selectedId === null ? null : `trade:${selectedId}`);
  const columnTotal = columnWidths.reduce((sum, width) => sum + width, 0);
  const toggleMonth = useCallback((month: string) => setExpandedMonths(current => ({
    ...current, [month]: !(current[month] ?? month === latestMonth),
  })), [latestMonth]);
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if ((event.key !== "ArrowUp" && event.key !== "ArrowDown") || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const visibleTrades = items.flatMap(item => item.kind === "trade" ? [item.row.trade] : []);
    if (!visibleTrades.length) return;
    event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
    const index = visibleTrades.findIndex(trade => trade.id === selectedId);
    const next = index < 0
      ? event.key === "ArrowDown" ? 0 : visibleTrades.length - 1
      : Math.max(0, Math.min(visibleTrades.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)));
    if (visibleTrades[next].id !== selectedId) onSelect(visibleTrades[next]);
  };
  return <TableContainer ref={containerRef} className="tl-table-container" tabIndex={0} onKeyDown={handleKeyDown} onScroll={onScroll}>
    <Table ref={tableRef} stickyHeader size="small" className="tl-trades-table" aria-label="Trade journal" aria-rowcount={items.length + 1}
      style={columnTotal ? { tableLayout: "fixed" } : undefined}>
      {columnTotal > 0 && <colgroup>{columnWidths.map((width, index) => <col key={index} style={{ width: `${width / columnTotal * 100}%` }} />)}</colgroup>}
      <TableHead><TableRow>
        {columns.map(({ key, label, numeric }) => <TableCell key={key} align={numeric ? "right" : "left"} sortDirection={sort.column === key ? sort.direction : false}>
          {key === "entry" ? label : <TableSortLabel active={sort.column === key} direction={sort.column === key ? sort.direction : "asc"} onClick={() => setSort(current => ({ column: key, direction: current.column === key ? current.direction === "asc" ? "desc" : "asc" : "asc" }))}>{label}</TableSortLabel>}
        </TableCell>)}<TableCell />
      </TableRow></TableHead>
      <TableBody>
        <Spacer height={before} />
        {items.slice(start, end).map((item, index) => item.kind === "month"
          ? <TradeMonthRow key={item.key} month={item.month} trades={item.trades} marks={marks} expanded={item.expanded} onToggle={toggleMonth} rowIndex={start + index + 2} />
          : <TradeDataRow key={item.key} row={item.row} selected={selectedId === item.row.trade.id} rowIndex={start + index + 2} onSelect={onSelect} onEdit={onEdit} />)}
        <Spacer height={after} />
        {!trades.length && <TableRow><TableCell colSpan={columns.length + 1} className="tl-empty-small">{loading ? "Loading trades…" : "No trades to display. Create a trade or adjust your filters."}</TableCell></TableRow>}
      </TableBody>
    </Table>
  </TableContainer>;
});

function Spacer({ height }: { height: number }) {
  return height > 0 ? <TableRow aria-hidden="true"><TableCell colSpan={columns.length + 1} style={{ height, padding: 0, border: 0 }} /></TableRow> : null;
}

const TradeDataRow = memo(function TradeDataRow({ row, selected, rowIndex, onSelect, onEdit }: {
  row: TradeRowData; selected: boolean; rowIndex: number; onSelect: (trade: TradeLog) => void; onEdit: (trade: TradeLog) => void;
}) {
  const { trade, open, mark, net, roi, quantity, size, tags: names, status } = row;
  const priceInfo = open ? mark?.mark_date ? `Valued at $${mark.mark_price}, daily close on ${mark.mark_date}. Includes recorded fees; future exit fees excluded.` : "Daily valuation unavailable or awaiting a completed close after the last execution." : "Final result after recorded fees.";
  return <TableRow aria-rowindex={rowIndex} hover selected={selected} className="tl-trade-row" onClick={() => onSelect(trade)}>
    <TableCell><Button className="tl-date-link" size="small" aria-label={`View charts for ${trade.symbol} trade ${trade.id}`} aria-expanded={selected} onClick={event => { event.stopPropagation(); onSelect(trade); }}>{localDate(trade.summary.opened_at)}</Button></TableCell>
    <TableCell><strong><TradeTickerLink trade={trade} /></strong></TableCell><TableCell className="tl-direction">{trade.direction}</TableCell><TableCell><Chip size="small" variant="outlined" label={status} className={open ? "" : pnlClass(trade.summary.realized_pnl)} /></TableCell>
    <TableCell align="right" className={`tl-return ${roi == null ? "" : pnlClass(String(roi))}`}><Tooltip title={`${priceInfo} Net P&L / total entry value × 100; shorts use sell-entry value, without margin assumptions.`}><span>{roi == null ? "—" : `${roi > 0 ? "+" : ""}${roi.toFixed(2)}%`}</span></Tooltip></TableCell>
    <TableCell align="right" className={`tl-return ${net === null ? "" : pnlClass(net)}`}><Tooltip title={priceInfo}><span>{money(net)}</span></Tooltip></TableCell>
    <TableCell align="right" className={pnlClass(trade.summary.realized_pnl)}>{money(trade.summary.realized_pnl)}</TableCell>
    <TableCell align="right" className={mark?.unrealized_pnl ? pnlClass(mark.unrealized_pnl) : ""}><Tooltip title={priceInfo}><span>{open ? money(mark?.unrealized_pnl) : "—"}</span></Tooltip></TableCell>
    <TableCell align="right">{money(trade.summary.average_entry_price)}</TableCell><TableCell align="right">{shares(quantity)}</TableCell>
    <TableCell align="right"><Tooltip title="Average entry price × remaining open shares, excluding fees. Short positions show a positive size."><span>{money(String(size))}</span></Tooltip></TableCell>
    <TableCell align="right"><Tooltip title={names.join(", ") || "No tags"}><span className="tl-table-tags" tabIndex={0}>{names.length}</span></Tooltip></TableCell>
    <TableCell><IconButton size="small" aria-label={`Edit ${trade.symbol} trade ${trade.id}`} onClick={event => { event.stopPropagation(); onEdit(trade); }}><EditOutlinedIcon fontSize="small" /></IconButton></TableCell>
  </TableRow>;
});
