import DeleteOutlinedIcon from "@mui/icons-material/DeleteOutlined";
import { Button, IconButton, InputAdornment, MenuItem, Select, TextField, Tooltip } from "@mui/material";
import { moneyInput } from "./format";

export interface EditableTradeExecution {
  key: string;
  id?: number;
  origin?: "broker" | "manual";
  timestamp: string;
  side: "buy" | "sell";
  position_effect: "open" | "close";
  quantity: string;
  price: string;
  fee: string;
}

interface TradeExecutionEditorProps {
  executions: EditableTradeExecution[];
  initialStop: string;
  activeStop: string;
  labelPrefix: string;
  showInitialStop?: boolean;
  showActiveStop?: boolean;
  onExecutionChange: (index: number, update: Partial<EditableTradeExecution>) => void;
  onStopChange: (kind: "initial" | "active", value: string) => void;
  onAdd?: () => void;
  onClosePosition?: () => void;
  onRemove?: (index: number) => void;
}

export function TradeExecutionEditor({
  executions,
  initialStop,
  activeStop,
  labelPrefix,
  showInitialStop = true,
  showActiveStop = true,
  onExecutionChange,
  onStopChange,
  onAdd,
  onClosePosition,
  onRemove,
}: TradeExecutionEditorProps) {
  return (
    <div className="import-execution-editor">
      {(showInitialStop || showActiveStop) && <div className="import-risk-stop-fields">
        {showInitialStop && <TextField className="import-risk-stop-field" size="small" type="number" label="Initial stop" value={initialStop} onChange={(event) => onStopChange("initial", event.target.value)} onBlur={(event) => onStopChange("initial", moneyInput(event.target.value))} slotProps={dollarSlots} />}
        {showActiveStop && <TextField className="import-risk-stop-field" size="small" type="number" label="Active stop" value={activeStop} onChange={(event) => onStopChange("active", event.target.value)} onBlur={(event) => onStopChange("active", moneyInput(event.target.value))} slotProps={dollarSlots} />}
      </div>}
      {executions.map((execution, index) => (
        <div className={`import-execution-fields${onRemove === undefined ? "" : " import-execution-fields-removable"}`} key={execution.key}>
          <TextField size="small" type="datetime-local" label="Timestamp" value={execution.timestamp} onChange={(event) => onExecutionChange(index, { timestamp: event.target.value })} slotProps={{ inputLabel: { shrink: true } }} />
          <Select size="small" value={execution.side} aria-label={`${labelPrefix} execution ${index + 1} side`} onChange={(event) => onExecutionChange(index, { side: event.target.value as EditableTradeExecution["side"] })}>
            <MenuItem value="buy">Buy</MenuItem><MenuItem value="sell">Sell</MenuItem>
          </Select>
          <Select size="small" value={execution.position_effect} aria-label={`${labelPrefix} execution ${index + 1} position effect`} onChange={(event) => onExecutionChange(index, { position_effect: event.target.value as EditableTradeExecution["position_effect"] })}>
            <MenuItem value="open">Open</MenuItem><MenuItem value="close">Close</MenuItem>
          </Select>
          <TextField size="small" type="number" label="Quantity" value={execution.quantity} onChange={(event) => onExecutionChange(index, { quantity: event.target.value })} />
          <TextField size="small" type="number" label="Price" value={execution.price} onChange={(event) => onExecutionChange(index, { price: event.target.value })} onBlur={(event) => onExecutionChange(index, { price: moneyInput(event.target.value) })} slotProps={dollarSlots} />
          <TextField size="small" type="number" label="Fee" value={execution.fee} onChange={(event) => onExecutionChange(index, { fee: event.target.value })} onBlur={(event) => onExecutionChange(index, { fee: moneyInput(event.target.value) })} slotProps={dollarSlots} />
          {onRemove !== undefined && <Tooltip title={index === 0
            ? "The opening execution identifies this trade"
            : execution.origin !== "manual"
              ? "Imported executions cannot be removed"
              : "Remove execution"}>
            <span>
              <IconButton size="small" disabled={index === 0 || execution.origin !== "manual"} aria-label={`Remove ${labelPrefix} execution ${index + 1}`} onClick={() => onRemove(index)}>
                <DeleteOutlinedIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>}
        </div>
      ))}
      {(onAdd !== undefined || onClosePosition !== undefined) && <div className="trade-execution-actions">
        {onAdd !== undefined && <Button size="small" variant="outlined" onClick={onAdd}>Add new leg</Button>}
        {onClosePosition !== undefined && <Button size="small" variant="outlined" color="warning" onClick={onClosePosition}>Close trade</Button>}
      </div>}
    </div>
  );
}

const dollarSlots = {
  input: { startAdornment: <InputAdornment position="start">$</InputAdornment> },
  htmlInput: { step: "0.01" },
};
