import { useState } from "react";
import { Dialog, DialogContent } from "@mui/material";
import type { TradeLog, TradeLogTag } from "../../api/tradeLogs";
import { SplitPane } from "../../components/SplitPane";
import { TradeDetails, type TradeExecutionSelection } from "./TradeDetails";
import { TradeHourlyChart } from "./TradeHourlyChart";
import { TradeLogChart } from "./TradeLogChart";
import { restoreChartSplit, saveChartSplit } from "../../shared/chartLayout";

const dailyWidthKey = "market-watch.trade-logs-overlay-daily-width-percent";

export function TradeChartsOverlay({ trade, tags, timeZone, selectedExecution, onSelect, onClose, onEdit }: {
  trade: TradeLog; tags: TradeLogTag[]; timeZone: string; selectedExecution: TradeExecutionSelection | null;
  onSelect: (index: number) => void; onClose: () => void; onEdit: () => void;
}) {
  const [initialDailyWidth] = useState(() => restoreChartSplit(dailyWidthKey, 50));
  return <Dialog open onClose={onClose} fullWidth maxWidth="xl" aria-label={`${trade.symbol} trade charts`} slotProps={{ paper: { className: "trade-logs-ui tl-charts-overlay" } }}>
    <DialogContent className="tl-charts-overlay-content">
      <div className="tl-charts-overlay-layout">
        <TradeHourlyChart trade={trade} timeZone={timeZone} onSelect={onSelect} onClose={onClose} />
        <SplitPane orientation="horizontal" initialSplit={100 - initialDailyWidth} onSplitChange={split => saveChartSplit(dailyWidthKey, 100 - split)}
          first={<TradeDetails trade={trade} tags={tags} timeZone={timeZone} selectedExecution={selectedExecution} />}
          second={<TradeLogChart trade={trade} onSelect={onSelect} onEdit={onEdit} />} />
      </div>
    </DialogContent>
  </Dialog>;
}
