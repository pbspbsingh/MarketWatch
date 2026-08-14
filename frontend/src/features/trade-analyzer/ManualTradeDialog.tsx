import { useState } from "react";
import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  InputLabel,
  InputAdornment,
  MenuItem,
  Select,
  TextField,
  Typography,
} from "@mui/material";
import {
  applyChange,
  deleteTrade,
  previewManualTrade,
  type ChangePreview as ChangePreviewData,
  type AnalyzerTrade,
  type TradeAccount,
  type TradeAnalyzerSnapshot,
} from "../../api/tradeAnalyzer";
import { ChangePreview } from "./ChangePreview";
import { moneyInput } from "./format";
import {
  TradeExecutionEditor,
  type EditableTradeExecution,
} from "./TradeExecutionEditor";

interface ManualTradeDialogProps {
  open: boolean;
  accounts: TradeAccount[];
  onClose: () => void;
  onApplied: (snapshot: TradeAnalyzerSnapshot) => void;
  onError: (message: string) => void;
  trade?: AnalyzerTrade;
}

const initialForm = {
  account_id: "",
  symbol: "",
  direction: "long",
  timestamp: "",
  quantity: "",
  price: "",
  fee: "0.00",
  initial_stop: "",
  active_stop: "",
  close_trade: false,
  close_timestamp: "",
  close_price: "",
  close_fee: "0.00",
  executions: [] as EditableTradeExecution[],
};

export function ManualTradeDialog({
  open,
  accounts,
  onClose,
  onApplied,
  onError,
  trade,
}: ManualTradeDialogProps) {
  const [form, setForm] = useState((): typeof initialForm => ({
    ...initialForm,
    account_id: String(trade?.account_id ?? accounts[0]?.id ?? ""),
    symbol: trade?.symbol ?? "",
    direction: trade?.direction ?? "long",
    timestamp: trade?.opened_at_local ?? localDateTimeValue(),
    quantity: trade?.quantity ?? "",
    price: moneyInput(trade?.average_entry ?? null),
    fee: moneyInput(trade?.executions.reduce((total, execution) => total + Number(execution.fee), 0).toString() ?? "0"),
    initial_stop: moneyInput(trade?.initial_stop ?? null),
    active_stop: moneyInput(trade?.active_stop ?? trade?.initial_stop ?? null),
    close_trade: false,
    close_timestamp: localDateTimeValue(),
    close_price: "",
    close_fee: "0.00",
    executions: trade?.executions.map((execution) => ({
      key: String(execution.id),
      id: execution.id,
      origin: execution.origin,
      timestamp: execution.timestamp_local.slice(0, 16),
      side: execution.side,
      position_effect: execution.position_effect,
      quantity: execution.quantity,
      price: moneyInput(execution.price),
      fee: moneyInput(execution.fee),
    })) ?? [],
  }));
  const [preview, setPreview] = useState<ChangePreviewData>();
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const input = {
    ...form,
    executions: form.executions.map((execution) => ({
      id: execution.id,
      timestamp: execution.timestamp,
      side: execution.side,
      position_effect: execution.position_effect,
      quantity: execution.quantity,
      price: execution.price,
      fee: execution.fee,
    })),
    account_id: Number(form.account_id),
    ...(trade === undefined ? {} : { trade_id: trade.id, revision: trade.revision }),
  };
  const selectedAccount = accounts.find(({ id }) => id === Number(form.account_id));
  const valid = selectedAccount !== undefined && (trade === undefined
    ? Boolean(form.symbol.trim() && form.timestamp
      && Number(form.quantity) > 0 && Number(form.price) > 0)
    : form.executions.length > 0 && form.executions.every((execution) => execution.timestamp
      && Number(execution.quantity) > 0
      && Number(execution.price) > 0
      && Number(execution.fee || 0) >= 0));
  const openPosition = form.executions.reduce((position, execution) => position
    + (execution.side === "buy" ? 1n : -1n) * quantityMicros(execution.quantity), 0n);

  const requestPreview = async () => {
    setBusy(true);
    try {
      setPreview(await previewManualTrade(input));
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    if (preview === undefined) return;
    setBusy(true);
    try {
      onApplied(await applyChange(preview, input));
      onClose();
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (trade === undefined) return;
    setBusy(true);
    try {
      onApplied(await deleteTrade(trade.id, trade.revision));
      onClose();
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const field = <K extends keyof typeof form,>(key: K, value: (typeof form)[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
    setPreview(undefined);
  };

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} maxWidth={trade === undefined ? "sm" : "lg"} fullWidth>
      <DialogTitle>{confirmingDelete ? `Delete ${trade?.symbol} trade?` : trade === undefined ? "Add manual trade" : `Edit ${trade.symbol} trade`}</DialogTitle>
      <DialogContent dividers className="trade-dialog-content">
        {confirmingDelete ? (
          <Typography>This permanently removes the trade and its executions. Reimporting the statement can recreate it.</Typography>
        ) : preview === undefined && trade !== undefined ? (
          <div className="edit-trade-executions">
            <div className="edit-trade-identity">
              <strong>{trade.symbol}</strong>
              <span>{trade.direction} · {trade.position_status}</span>
            </div>
            <TradeExecutionEditor
              executions={form.executions}
              initialStop={form.initial_stop}
              activeStop={form.active_stop}
              labelPrefix={trade.symbol}
              onExecutionChange={(index, update) => field("executions", form.executions.map((execution, executionIndex) => executionIndex === index ? { ...execution, ...update } : execution))}
              onStopChange={(kind, value) => field(kind === "initial" ? "initial_stop" : "active_stop", value)}
              onAdd={openPosition === 0n ? undefined : () => field("executions", [...form.executions, {
                key: crypto.randomUUID(),
                origin: "manual",
                timestamp: localDateTimeValue(),
                side: openPosition > 0n ? "buy" : "sell",
                position_effect: "open",
                quantity: "",
                price: "",
                fee: "0.00",
              }])}
              onClosePosition={openPosition === 0n ? undefined : () => field("executions", [...form.executions, {
                key: crypto.randomUUID(),
                origin: "manual",
                timestamp: localDateTimeValue(),
                side: openPosition > 0n ? "sell" : "buy",
                position_effect: "close",
                quantity: formatQuantityMicros(openPosition < 0n ? -openPosition : openPosition),
                price: "",
                fee: "0.00",
              }])}
              onRemove={(index) => field("executions", form.executions.filter((_, executionIndex) => executionIndex !== index))}
            />
          </div>
        ) : preview === undefined ? (
          <div className="manual-trade-grid">
            {trade === undefined && <FormControl size="small" className="manual-field-wide">
              <InputLabel id="manual-account-label">Account</InputLabel>
              <Select
                labelId="manual-account-label"
                label="Account"
                value={form.account_id}
                disabled={trade !== undefined}
                onChange={(event) => field("account_id", event.target.value)}
              >
                {accounts.map((account) => <MenuItem key={account.id} value={account.id}>{account.label}</MenuItem>)}
              </Select>
            </FormControl>}
            {trade === undefined && <TextField size="small" label="Symbol" value={form.symbol} onChange={(event) => field("symbol", event.target.value.toUpperCase())} />}
            {trade === undefined && <FormControl size="small">
              <InputLabel id="manual-direction-label">Direction</InputLabel>
              <Select labelId="manual-direction-label" label="Direction" value={form.direction} onChange={(event) => field("direction", event.target.value)}>
                <MenuItem value="long">Long</MenuItem><MenuItem value="short">Short</MenuItem>
              </Select>
            </FormControl>}
            {trade === undefined && <TextField className="manual-field-wide" size="small" type="datetime-local" label="Execution time" value={form.timestamp} onChange={(event) => field("timestamp", event.target.value)} slotProps={{ inputLabel: { shrink: true } }} />}
            <TextField size="small" type="number" label="Quantity" value={form.quantity} onChange={(event) => field("quantity", event.target.value)} />
            <TextField size="small" type="number" label="Entry price" value={form.price} onChange={(event) => field("price", event.target.value)} onBlur={(event) => field("price", moneyInput(event.target.value))} slotProps={dollarSlots} />
            {trade === undefined && <TextField size="small" type="number" label="Fee" value={form.fee} onChange={(event) => field("fee", event.target.value)} onBlur={(event) => field("fee", moneyInput(event.target.value))} slotProps={dollarSlots} />}
            <TextField size="small" type="number" label="Initial stop" value={form.initial_stop} onChange={(event) => field("initial_stop", event.target.value)} onBlur={(event) => field("initial_stop", moneyInput(event.target.value))} slotProps={dollarSlots} />
            <TextField size="small" type="number" label="Active stop" value={form.active_stop} onChange={(event) => field("active_stop", event.target.value)} onBlur={(event) => field("active_stop", moneyInput(event.target.value))} slotProps={dollarSlots} />
          </div>
        ) : <ChangePreview preview={preview} />}
      </DialogContent>
      <DialogActions>
        {confirmingDelete ? (
          <>
            <Button disabled={busy} onClick={() => setConfirmingDelete(false)}>Cancel</Button>
            <Button color="error" variant="contained" disabled={busy} onClick={() => void remove()}>{busy ? "Deleting…" : "Delete trade"}</Button>
          </>
        ) : (
          <>
            {trade !== undefined && preview === undefined && <Button color="error" disabled={busy} onClick={() => setConfirmingDelete(true)}>Delete trade</Button>}
            <Button disabled={busy} onClick={onClose}>Cancel</Button>
            {preview !== undefined && <Button disabled={busy} onClick={() => setPreview(undefined)}>Edit</Button>}
            {preview === undefined ? (
              <Button variant="contained" disabled={!valid || busy} onClick={() => void requestPreview()}>{busy ? "Preparing…" : "Preview trade"}</Button>
            ) : (
              <Button variant="contained" disabled={busy} onClick={() => void apply()}>{busy ? "Applying…" : "Apply trade"}</Button>
            )}
          </>
        )}
      </DialogActions>
    </Dialog>
  );
}

function localDateTimeValue() {
  const date = new Date(Date.now() - new Date().getTimezoneOffset() * 60_000);
  return date.toISOString().slice(0, 16);
}

function quantityMicros(value: string): bigint {
  const match = /^(\d+)(?:\.(\d*))?$/.exec(value.trim());
  if (match === null) return 0n;
  const fraction = (match[2] ?? "").padEnd(6, "0").slice(0, 6);
  return BigInt(match[1]) * 1_000_000n + BigInt(fraction || "0");
}

function formatQuantityMicros(value: bigint): string {
  const whole = value / 1_000_000n;
  const fraction = (value % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

const dollarSlots = {
  input: { startAdornment: <InputAdornment position="start">$</InputAdornment> },
  htmlInput: { step: "0.01" },
};

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Request failed";
}
