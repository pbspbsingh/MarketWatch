import { memo, useCallback, useState, type Dispatch, type SetStateAction } from "react";
import { Checkbox } from "@mui/material";
import type {
  ImportExecutionPreview,
  ImportStopPreview,
  ImportTradePreview,
} from "../../api/tradeAnalyzer";
import { decimal, money, pnlClass, signedMoney } from "./format";
import { TradeExecutionEditor } from "./TradeExecutionEditor";

interface ImportTradeTableProps {
  trades: ImportTradePreview[];
  onChange: Dispatch<SetStateAction<ImportTradePreview[]>>;
}

export function ImportTradeTable({ trades, onChange }: ImportTradeTableProps) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const updateTrade = useCallback((
    rowKey: string,
    update: (trade: ImportTradePreview) => ImportTradePreview,
  ) => {
    onChange((current) => current.map((trade) => trade.row_key === rowKey ? update(trade) : trade));
  }, [onChange]);
  const setTradeExpanded = useCallback((rowKey: string, open: boolean) => {
    setExpanded((current) => {
      if (current.has(rowKey) === open) return current;
      const next = new Set(current);
      if (open) next.add(rowKey);
      else next.delete(rowKey);
      return next;
    });
  }, []);

  if (trades.length === 0) {
    return <p className="import-trades-empty">No new or changed trades in this statement.</p>;
  }

  return (
    <div className="import-trades-wrap">
      <table className="import-trades-table">
        <thead>
          <tr>
            <th><span className="sr-only">Include</span></th>
            <th>Trade</th>
            <th>Action</th>
            <th>Status</th>
            <th>Qty</th>
            <th>Entry</th>
            <th>Stop</th>
            <th>P&amp;L</th>
            <th>Open risk</th>
          </tr>
        </thead>
        <tbody>
          {trades.map((trade, tradeIndex) => (
            <TradePreviewRows
              key={trade.row_key}
              trade={trade}
              tradeIndex={tradeIndex}
              expanded={expanded.has(trade.row_key)}
              onExpanded={setTradeExpanded}
              onChange={updateTrade}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

const TradePreviewRows = memo(function TradePreviewRows({
  trade,
  tradeIndex,
  expanded,
  onExpanded,
  onChange,
}: {
  trade: ImportTradePreview;
  tradeIndex: number;
  expanded: boolean;
  onExpanded: (rowKey: string, open: boolean) => void;
  onChange: (
    rowKey: string,
    update: (trade: ImportTradePreview) => ImportTradePreview,
  ) => void;
}) {
  const initialStopIndex = trade.stops.findIndex((stop) => stop.kind === "initial");
  const activeStopIndex = trade.stops.findIndex((stop) => stop.kind === "active");
  const updateExecution = (index: number, update: Partial<ImportExecutionPreview>) => {
    onChange(trade.row_key, (current) => ({
      ...current,
      executions: current.executions.map((execution, executionIndex) =>
        executionIndex === index ? { ...execution, ...update } : execution),
    }));
  };
  const updateStop = (index: number, update: Partial<ImportStopPreview>) => {
    onChange(trade.row_key, (current) => ({
      ...current,
      stops: current.stops.map((stop, stopIndex) =>
        stopIndex === index ? { ...stop, ...update } : stop),
    }));
  };
  return (
    <>
      <tr className={`${trade.direction === "short" ? "import-trade-short" : ""}${trade.included ? "" : " import-trade-excluded"}`.trim() || undefined}>
        <td>
          <Checkbox
            size="small"
            checked={trade.included}
            onChange={(event) => onChange(trade.row_key, (current) => ({
              ...current,
              included: event.target.checked,
            }))}
            slotProps={{ input: { "aria-label": `Include ${trade.symbol} trade` } }}
          />
        </td>
        <td>
          <strong>{trade.symbol}</strong>
          <small>{trade.direction} · {formatTimestamp(trade.opened_at_local)}</small>
        </td>
        <td>{trade.action}</td>
        <td>{trade.position_status}<small>{trade.history_quality}</small></td>
        <td>{decimal(trade.remaining_quantity)} / {decimal(trade.quantity)}</td>
        <td>{money(trade.average_entry)}</td>
        <td>{money(trade.active_stop)}<small>initial {money(trade.initial_stop)}</small></td>
        <td className={pnlClass(trade.projected_pnl)}>{signedMoney(trade.projected_pnl)}</td>
        <td>{money(trade.open_risk)}</td>
      </tr>
      <tr className="import-trade-editor-row">
        <td />
        <td colSpan={8}>
          <details
            open={expanded}
            onToggle={(event) => onExpanded(trade.row_key, event.currentTarget.open)}
          >
            <summary>Edit {trade.executions.length} execution{trade.executions.length === 1 ? "" : "s"}{trade.stops.length > 0 ? " and risk stops" : ""}</summary>
            {expanded && <TradeExecutionEditor
              executions={trade.executions.map((execution) => ({ ...execution, key: execution.event_key }))}
              initialStop={initialStopIndex < 0 ? "" : trade.stops[initialStopIndex].price}
              activeStop={activeStopIndex < 0 ? "" : trade.stops[activeStopIndex].price}
              labelPrefix={`trade ${tradeIndex + 1}`}
              showInitialStop={initialStopIndex >= 0}
              showActiveStop={activeStopIndex >= 0}
              onExecutionChange={updateExecution}
              onStopChange={(kind, value) => {
                const index = kind === "initial" ? initialStopIndex : activeStopIndex;
                if (index >= 0) updateStop(index, { price: value });
              }}
            />}
          </details>
        </td>
      </tr>
    </>
  );
});

function formatTimestamp(value: string | null) {
  return value?.replace("T", " ") ?? "—";
}
