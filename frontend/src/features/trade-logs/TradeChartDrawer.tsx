import { memo, useState } from "react";
import { Drawer } from "@mui/material";
import type { TradeLog, TradeLogTag } from "../../api/tradeLogs";
import { TradeLogChart } from "./TradeLogChart";
import { TradeDetails, type TradeExecutionSelection } from "./TradeDetails";
import { TradeChartsOverlay } from "./TradeChartsOverlay";

export const TradeChartDrawer = memo(function TradeChartDrawer({ trade, tags, timeZone, onClose, onEdit }: { trade: TradeLog | null; tags: TradeLogTag[]; timeZone: string | null; onClose: () => void; onEdit: (trade: TradeLog) => void }) {
  return <Drawer anchor="right" variant="persistent" open={trade !== null} className="tl-chart-drawer" slotProps={{ paper: { className: "trade-logs-ui tl-chart-drawer-paper" } }}>
    {trade && timeZone && <DrawerContents key={trade.id} trade={trade} tags={tags} timeZone={timeZone} onClose={onClose} onEdit={onEdit} />}
  </Drawer>;
});
function DrawerContents({ trade, tags, timeZone, onClose, onEdit }: { trade: TradeLog; tags: TradeLogTag[]; timeZone: string; onClose: () => void; onEdit: (trade: TradeLog) => void }) {
  const [selected, setSelected] = useState<TradeExecutionSelection | null>(null);
  const [expanded, setExpanded] = useState(false);
  const selectExecution = (index: number) => {
    const id = trade.executions[index]?.id;
    setSelected(id == null ? null : { id });
  };
  return <>
    <div className="tl-drawer-charts">
      <TradeLogChart trade={trade} onSelect={selectExecution} onClose={onClose} onEdit={() => onEdit(trade)} onExpand={() => setExpanded(true)} />
      <TradeDetails trade={trade} tags={tags} timeZone={timeZone} selectedExecution={selected} />
    </div>
    {expanded && <TradeChartsOverlay trade={trade} tags={tags} timeZone={timeZone} selectedExecution={selected} onSelect={selectExecution} onClose={() => setExpanded(false)} onEdit={() => { setExpanded(false); onEdit(trade); }} />}
  </>;
}
