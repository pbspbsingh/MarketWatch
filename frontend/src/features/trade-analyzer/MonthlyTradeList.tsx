import { useState } from "react";
import ExpandLessIcon from "@mui/icons-material/ExpandLess";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import WarningAmberOutlinedIcon from "@mui/icons-material/WarningAmberOutlined";
import EditOutlinedIcon from "@mui/icons-material/EditOutlined";
import {
  Autocomplete,
  Button,
  Chip,
  Collapse,
  IconButton,
  LinearProgress,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import type {
  AnalyzerTrade,
  TradeAccount,
  TradeMonthSummary,
  TradeTag,
} from "../../api/tradeAnalyzer";
import { decimal, localDate, money, pnlClass, signedMoney } from "./format";

interface MonthlyTradeListProps {
  accounts: TradeAccount[];
  months: TradeMonthSummary[];
  trades: AnalyzerTrade[];
  tags: TradeTag[];
  loading: boolean;
  showJournalColumns: boolean;
  selectedTradeId?: number;
  onSelectTrade: (tradeId: number) => void;
  onSaveJournal: (trade: AnalyzerTrade, comment: string, tags: TradeTag[]) => Promise<void>;
  onEditTrade: (trade: AnalyzerTrade) => void;
}

export function MonthlyTradeList({
  accounts,
  months,
  trades,
  tags,
  loading,
  showJournalColumns,
  selectedTradeId,
  onSelectTrade,
  onSaveJournal,
  onEditTrade,
}: MonthlyTradeListProps) {
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const accountById = new Map(accounts.map((account) => [account.id, account]));
  const monthGroups = months.flatMap((month) => {
    const monthTrades = trades.filter((trade) => trade.opening_month === month.key
      && trade.account_id === month.account_id);
    return monthTrades.length === 0 ? [] : [{ month, trades: monthTrades }];
  });
  const latestMonth = monthGroups.reduce<(typeof monthGroups)[number] | undefined>(
    (latest, group) => latest === undefined || group.month.key > latest.month.key ? group : latest,
    undefined,
  );

  return (
    <section className="trade-list-pane" aria-label="Trade journal">
      {loading && <LinearProgress aria-label="Loading trades" />}
      <div className="trade-list-scroll">
        {!loading && trades.length === 0 && (
          <div className="trade-empty-state">
            <Typography component="h2">No trades match these filters</Typography>
            <Typography color="text.secondary">
              Import a broker statement or add a manual trade to begin.
            </Typography>
          </div>
        )}
        {monthGroups.map(({ month, trades: monthTrades }) => (
            <MonthGroup
              key={`${month.account_id}:${month.key}:${month === latestMonth?.month ? "expanded" : "collapsed"}`}
              month={month}
              account={accountById.get(month.account_id)}
              trades={monthTrades}
              defaultExpanded={month === latestMonth?.month}
              tags={tags}
              showJournalColumns={showJournalColumns}
              expanded={expanded}
              selectedTradeId={selectedTradeId}
              onSelectTrade={onSelectTrade}
              onToggle={(tradeId) => setExpanded((current) => {
                const next = new Set(current);
                if (next.has(tradeId)) next.delete(tradeId);
                else next.add(tradeId);
                return next;
              })}
              onSaveJournal={onSaveJournal}
              onEditTrade={onEditTrade}
            />
        ))}
      </div>
    </section>
  );
}

function MonthGroup({
  month,
  account,
  trades,
  defaultExpanded,
  tags,
  showJournalColumns,
  expanded,
  selectedTradeId,
  onSelectTrade,
  onToggle,
  onSaveJournal,
  onEditTrade,
}: {
  month: TradeMonthSummary;
  account?: TradeAccount;
  trades: AnalyzerTrade[];
  defaultExpanded: boolean;
  tags: TradeTag[];
  showJournalColumns: boolean;
  expanded: Set<number>;
  selectedTradeId?: number;
  onSelectTrade: (tradeId: number) => void;
  onToggle: (tradeId: number) => void;
  onSaveJournal: MonthlyTradeListProps["onSaveJournal"];
  onEditTrade: (trade: AnalyzerTrade) => void;
}) {
  const [tradesOpen, setTradesOpen] = useState(defaultExpanded);
  const tableId = `trade-month-table-${month.account_id}-${month.key}`;
  return (
    <section className="trade-month" aria-labelledby={`trade-month-${month.account_id}-${month.key}`}>
      <header
        className="trade-month-heading"
        role="button"
        tabIndex={0}
        aria-expanded={tradesOpen}
        aria-controls={tableId}
        aria-label={tradesOpen ? `Collapse ${month.label} trades` : `Expand ${month.label} trades`}
        onClick={() => setTradesOpen((open) => !open)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          setTradesOpen((open) => !open);
        }}
      >
        <div className="trade-month-title">
          <strong id={`trade-month-${month.account_id}-${month.key}`}>{month.label}</strong>
        </div>
        <MonthSummary summary={month} />
        <span className="trade-month-toggle" aria-hidden="true">
          {tradesOpen ? <ExpandLessIcon fontSize="small" /> : <ExpandMoreIcon fontSize="small" />}
        </span>
      </header>
      <Collapse id={tableId} in={tradesOpen} timeout="auto" unmountOnExit>
        <div className="trade-table-wrap">
          <table className="trade-table">
            <thead>
              <tr>
                <th aria-label="Expand" />
                <th>Date</th><th>Symbol</th><th>Status</th><th>Position</th><th>Entry</th>
                <th>Stop</th><th>Mark / Exit</th><th>P&amp;L</th><th>Open risk</th><th>R</th>
                {showJournalColumns && <><th>Tags</th><th>Journal</th></>}
              </tr>
            </thead>
            <tbody>
              {trades.map((trade) => (
                <TradeRows
                  key={trade.id}
                  trade={trade}
                  timezone={account?.timezone ?? "America/Los_Angeles"}
                  allTags={tags}
                  showJournalColumns={showJournalColumns}
                  expanded={expanded.has(trade.id)}
                  selected={trade.id === selectedTradeId}
                  onSelect={() => onSelectTrade(trade.id)}
                  onToggle={() => onToggle(trade.id)}
                  onSaveJournal={onSaveJournal}
                  onEditTrade={onEditTrade}
                />
              ))}
            </tbody>
          </table>
        </div>
      </Collapse>
    </section>
  );
}

function MonthSummary({ summary }: { summary: TradeMonthSummary }) {
  const values = [
    ["Closed / Open", `${summary.closed} / ${summary.open}`],
    ["Win rate", summary.win_rate === null ? "—" : `${summary.win_rate}%`],
    ["Net P&L", signedMoney(summary.net_pnl), pnlClass(summary.net_pnl)],
    ["Open risk", money(summary.open_risk)],
    ["Profit factor", decimal(summary.profit_factor)],
    ["Avg R", decimal(summary.average_r, "R")],
  ];
  return (
    <div className="trade-month-summary">
      {values.map(([label, value, className]) => (
        <div key={label}>
          <small>{label}</small>
          <strong className={className}>{value}</strong>
        </div>
      ))}
      {summary.incomplete > 0 && (
        <Chip size="small" color="warning" variant="outlined" label={`${summary.incomplete} need review`} />
      )}
    </div>
  );
}

function TradeRows({
  trade,
  timezone,
  allTags,
  showJournalColumns,
  expanded,
  selected,
  onSelect,
  onToggle,
  onSaveJournal,
  onEditTrade,
}: {
  trade: AnalyzerTrade;
  timezone: string;
  allTags: TradeTag[];
  showJournalColumns: boolean;
  expanded: boolean;
  selected: boolean;
  onSelect: () => void;
  onToggle: () => void;
  onSaveJournal: MonthlyTradeListProps["onSaveJournal"];
  onEditTrade: (trade: AnalyzerTrade) => void;
}) {
  const markOrExit = trade.position_status === "open" ? trade.current_mark : trade.average_exit;
  return (
    <>
      <tr
        className={`trade-row${selected ? " trade-row-selected" : ""}${trade.direction === "short" ? " trade-row-short" : ""}`}
        onClick={onSelect}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          switch (event.key) {
            case "ArrowDown":
              event.preventDefault();
              focusTradeRow(event.currentTarget, "next");
              break;
            case "ArrowUp":
              event.preventDefault();
              focusTradeRow(event.currentTarget, "previous");
              break;
            case "Home":
              event.preventDefault();
              focusTradeRow(event.currentTarget, "first");
              break;
            case "End":
              event.preventDefault();
              focusTradeRow(event.currentTarget, "last");
              break;
            case "ArrowRight":
              if (!expanded) {
                event.preventDefault();
                onToggle();
              }
              break;
            case "ArrowLeft":
              if (expanded) {
                event.preventDefault();
                onToggle();
              }
              break;
            case "Enter":
            case " ":
              event.preventDefault();
              onSelect();
              break;
          }
        }}
        tabIndex={0}
        aria-selected={selected}
        aria-expanded={expanded}
        aria-controls={`trade-details-${trade.id}`}
      >
        <td>
          <IconButton
            size="small"
            aria-label={expanded ? `Collapse ${trade.symbol}` : `Expand ${trade.symbol}`}
            onClick={(event) => { event.stopPropagation(); onToggle(); }}
          >
            {expanded ? <ExpandLessIcon fontSize="small" /> : <ExpandMoreIcon fontSize="small" />}
          </IconButton>
        </td>
        <td>{localDate(trade.opened_at, timezone)}</td>
        <td><strong>{trade.symbol}</strong><small>{trade.direction}</small></td>
        <td><TradeStatus trade={trade} /></td>
        <td>{decimal(trade.remaining_quantity)} / {decimal(trade.quantity)}</td>
        <td>{money(trade.average_entry)}</td>
        <td>{money(trade.active_stop)}<small>initial {money(trade.initial_stop)}</small></td>
        <td>{money(markOrExit)}<small>{trade.mark_date ?? ""}</small></td>
        <td className={pnlClass(trade.total_pnl)}>
          <strong>{signedMoney(trade.total_pnl)}</strong>
          <small>{decimal(trade.pnl_percent, "%")}</small>
        </td>
        <td>{money(trade.open_risk)}</td>
        <td>{decimal(trade.r_multiple, "R")}</td>
        {showJournalColumns && (
          <>
            <td>
              <div className="trade-table-tags">
                {trade.tags.map((tag) => <Chip key={tag.id} size="small" label={tag.name} />)}
              </div>
            </td>
            <td className="trade-table-journal" title={trade.comment}>{trade.comment || "—"}</td>
          </>
        )}
      </tr>
      <tr id={`trade-details-${trade.id}`} className="trade-expanded-row">
        <td colSpan={showJournalColumns ? 13 : 11}>
          <Collapse in={expanded} timeout="auto" unmountOnExit>
            <TradeDetails trade={trade} allTags={allTags} onSaveJournal={onSaveJournal} onEditTrade={onEditTrade} />
          </Collapse>
        </td>
      </tr>
    </>
  );
}

function focusTradeRow(
  current: HTMLTableRowElement,
  destination: "next" | "previous" | "first" | "last",
) {
  const rows = Array.from(
    current.closest(".trade-list-scroll")?.querySelectorAll<HTMLTableRowElement>(".trade-row") ?? [],
  );
  const index = rows.indexOf(current);
  const target = destination === "first"
    ? rows[0]
    : destination === "last"
      ? rows.at(-1)
      : rows[index + (destination === "next" ? 1 : -1)];
  target?.focus();
}

function TradeStatus({ trade }: { trade: AnalyzerTrade }) {
  if (trade.history_quality !== "complete") {
    return (
      <Tooltip title="Some lifecycle facts are incomplete or conflicting">
        <Chip
          size="small"
          color="warning"
          icon={<WarningAmberOutlinedIcon />}
          label={trade.history_quality}
        />
      </Tooltip>
    );
  }
  const unprotected = Number(trade.unprotected_quantity) > 0;
  return <Chip size="small" color={unprotected ? "warning" : trade.position_status === "open" ? "info" : "default"} label={unprotected ? "unprotected" : trade.position_status} />;
}

function TradeDetails({
  trade,
  allTags,
  onSaveJournal,
  onEditTrade,
}: {
  trade: AnalyzerTrade;
  allTags: TradeTag[];
  onSaveJournal: MonthlyTradeListProps["onSaveJournal"];
  onEditTrade: (trade: AnalyzerTrade) => void;
}) {
  const [comment, setComment] = useState(trade.comment);
  const [selectedTags, setSelectedTags] = useState(trade.tags);
  const [saving, setSaving] = useState(false);
  return (
    <div className="trade-details">
      <section>
        <div className="trade-details-heading">
          <Typography component="h3">Executions</Typography>
          <Button size="small" startIcon={<EditOutlinedIcon />} onClick={() => onEditTrade(trade)}>Edit trade</Button>
        </div>
        <div className="trade-leg-list">
          {trade.executions.map((leg) => (
            <div key={leg.id}>
              <Chip size="small" label={leg.kind} color={leg.kind === "entry" ? "success" : "error"} />
              <span>{new Date(leg.timestamp).toLocaleString()}</span>
              <strong>{leg.quantity} @ {money(leg.price)}</strong>
              <small>fee {money(leg.fee)}</small>
            </div>
          ))}
        </div>
      </section>
      <section className="trade-journal-editor">
        <Typography component="h3">Comment &amp; tags</Typography>
        <TextField
          multiline
          minRows={3}
          fullWidth
          size="small"
          label="Trade comment"
          value={comment}
          onChange={(event) => setComment(event.target.value)}
        />
        <Autocomplete
          multiple
          freeSolo
          size="small"
          options={allTags}
          value={selectedTags}
          getOptionLabel={(tag) => typeof tag === "string" ? tag : tag.name}
          isOptionEqualToValue={(option, value) => typeof option !== "string"
            && typeof value !== "string" && option.id === value.id}
          onChange={(_, value) => setSelectedTags(value.map((tag, index) => typeof tag === "string"
            ? { id: -(Date.now() + index), name: tag.trim() }
            : tag).filter(({ name }) => name.length > 0))}
          renderInput={(params) => <TextField {...params} label="Tags" />}
        />
        <Button
          size="small"
          variant="contained"
          disabled={saving || (comment === trade.comment && selectedTags.map(({ id }) => id).join() === trade.tags.map(({ id }) => id).join())}
          onClick={() => {
            setSaving(true);
            void onSaveJournal(trade, comment, selectedTags).finally(() => setSaving(false));
          }}
        >
          {saving ? "Saving…" : "Save journal"}
        </Button>
      </section>
    </div>
  );
}
