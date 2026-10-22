import { Fragment, useEffect, useMemo, useRef } from "react";
import type { TradeLog, TradeLogAction, TradeLogTag } from "../../api/tradeLogs";
import { money, pnlClass, shares } from "./format";
import { tradeTimeFormatters } from "./timeFormat";
import { PnlValue } from "./PnlValue";

const actionNames: Record<TradeLogAction, string> = { Open: "Entry", Add: "Add", Reduce: "Partial exit", Close: "Exit" };
const priceFormat = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 6 });

export interface TradeExecutionSelection { id: number }

export function TradeDetails({ trade, tags, timeZone, selectedExecution }: {
  trade: TradeLog; tags: TradeLogTag[]; timeZone: string; selectedExecution: TradeExecutionSelection | null;
}) {
  const labels = useMemo(() => tradeTimeFormatters(timeZone), [timeZone]);
  const tagNames = new Map(tags.map(tag => [tag.id, tag.name]));
  const selectedRef = useRef<HTMLTableRowElement>(null);
  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [selectedExecution, trade.executions]);
  return <section className="tl-trade-details tl-trade-view-section" aria-label="Trade details">
    <div className="tl-section-heading"><h3>Trade details</h3><span>{timeZone}</span></div>
    <div className="tl-trade-details-body">
      <dl className="tl-trade-details-summary">
        <div><dt>Average entry</dt><dd>{money(trade.summary.average_entry_price)}</dd></div>
        <div><dt>Open shares</dt><dd>{shares(trade.summary.remaining_quantity)}</dd></div>
        <div><dt>Realized P&L</dt><dd className={pnlClass(trade.summary.realized_pnl)} title="After-fee profit / entry value of exited shares."><PnlValue amount={trade.summary.realized_pnl} returnPercent={trade.summary.realized_return_percent} /></dd></div>
        <div><dt>Total fees</dt><dd>{money(trade.summary.fees)}</dd></div>
      </dl>
      <DetailTags ids={trade.tag_ids} names={tagNames} label="Trade tags" />
      <h4>Executions · {trade.executions.length}</h4>
      <table className="tl-executions-table" aria-label="Trade executions">
        <thead><tr><th scope="col">Execution</th><th scope="col">Shares</th><th scope="col">Price</th><th scope="col">Remaining</th><th scope="col">Fee</th><th scope="col" title="After-fee profit / entry value of the shares exited by this execution.">Realized P&L</th></tr></thead>
        <tbody>{trade.executions.map((leg, index) => {
          const selected = leg.id === selectedExecution?.id;
          const side = trade.direction === "short" ? leg.side === "buy" ? "Cover" : "Short" : leg.side === "buy" ? "Buy" : "Sell";
          return <Fragment key={leg.id ?? index}>
            <tr ref={selected ? selectedRef : null} className={selected ? "tl-execution-detail-selected" : undefined} aria-current={selected ? "true" : undefined}>
              <td><div className="tl-execution-label"><span className={leg.side === "buy" ? "tl-positive" : "tl-negative"}>{leg.action[0]}{index + 1}</span><strong>{actionNames[leg.action]}</strong><span className="tl-execution-side">{side}</span></div><time dateTime={leg.executed_at}>{labels.dateTime.format(new Date(leg.executed_at))}</time></td>
              <td>{shares(leg.quantity)}</td><td>{priceFormat.format(Number(leg.price))}</td><td>{shares(leg.remaining_quantity)}</td><td>{money(leg.fee)}</td>
              <td className={pnlClass(leg.realized_pnl)}>{leg.action === "Reduce" || leg.action === "Close" ? <PnlValue amount={leg.realized_pnl} returnPercent={leg.net_return_percent} /> : "—"}</td>
            </tr>
            {(leg.tag_ids.length > 0 || leg.notes) && <tr className={`tl-execution-annotation${selected ? " tl-execution-detail-selected" : ""}`}><td colSpan={6}>
              <DetailTags ids={leg.tag_ids} names={tagNames} label="Execution tags" />
              {leg.notes && <p className="tl-detail-note">{leg.notes}</p>}
            </td></tr>}
          </Fragment>;
        })}</tbody>
      </table>
      {trade.notes && <div className="tl-trade-notes"><h4>Trade notes</h4><p className="tl-detail-note">{trade.notes}</p></div>}
    </div>
  </section>;
}

function DetailTags({ ids, names, label }: { ids: number[]; names: Map<number, string>; label: string }) {
  return ids.length > 0 && <div className="tl-detail-tags" aria-label={label}>{ids.map(id => <span key={id}>{names.get(id) ?? `Unavailable tag #${id}`}</span>)}</div>;
}
