import { useEffect, useState } from "react";
import { Alert, Button, Chip, CircularProgress, IconButton, MenuItem, TextField, Tooltip } from "@mui/material";
import AddIcon from "@mui/icons-material/Add";
import CloseIcon from "@mui/icons-material/Close";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutlined";
import ArrowUpwardIcon from "@mui/icons-material/ArrowUpward";
import ArrowDownwardIcon from "@mui/icons-material/ArrowDownward";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import { previewTradeLog, type TradeLog, type TradeLogDirection, type TradeLogExecutionInput, type TradeLogInput, type TradeLogTag } from "../../api/tradeLogs";
import { TagPicker } from "./TagPicker";
import { errorMessage, localDateTime, money, newExecution, payload, pnlClass, shares } from "./format";

export function TradeEditor({ draft, saved, tags, dirty, busy, onChange, onSave, onReset, onDelete, onClose }: {
  draft: TradeLogInput; saved: TradeLog | null; tags: TradeLogTag[]; dirty: boolean; busy: boolean;
  onChange: (draft: TradeLogInput) => void; onSave: () => void; onReset: () => void; onDelete: () => void; onClose: () => void;
}) {
  const signature = JSON.stringify(draft);
  const [result, setResult] = useState<{ signature: string; trade?: TradeLog; error?: string } | null>(null);
  const [lastValidTrade, setLastValidTrade] = useState<TradeLog | null>(saved);
  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      let input: TradeLogInput;
      const draft = JSON.parse(signature) as TradeLogInput;
      if (!draft.symbol.trim()) { setResult({ signature, error: "Enter a ticker to calculate this trade." }); return; }
      if (!/^[a-zA-Z0-9.-]+$/.test(draft.symbol.trim())) { setResult({ signature, error: "Use a stock or ETF ticker, such as AAPL or BRK-B." }); return; }
      try { input = payload(draft); }
      catch { setResult({ signature, error: "Enter a valid date and time for every execution." }); return; }
      void previewTradeLog(input, controller.signal)
        .then(trade => { if (!controller.signal.aborted) { setResult({ signature, trade }); setLastValidTrade(trade); } })
        .catch(error => { if (!controller.signal.aborted) setResult({ signature, error: errorMessage(error) }); });
    }, 350);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [signature]);
  const preview = result?.signature === signature ? result.trade : undefined;
  const validation = result?.signature === signature ? result.error : undefined;
  const summary = preview?.summary ?? lastValidTrade?.summary;
  const short = draft.direction === "short";
  const entrySide = short ? "sell" : "buy";
  const exitSide = short ? "buy" : "sell";
  const changeDirection = (direction: TradeLogDirection) => {
    if (direction === draft.direction) return;
    onChange({ ...draft, direction, executions: draft.executions.map(leg => ({ ...leg, side: leg.side === "buy" ? "sell" : "buy" })) });
  };
  const setLeg = (index: number, patch: Partial<TradeLogExecutionInput>) => onChange({ ...draft, executions: draft.executions.map((leg, i) => i === index ? { ...leg, ...patch } : leg) });
  const append = (side: "buy" | "sell", close = false) => onChange({ ...draft, executions: [...draft.executions, newExecution(side, close ? summary?.remaining_quantity : "")] });
  const move = (index: number, direction: number) => {
    const legs = [...draft.executions];
    [legs[index], legs[index + direction]] = [legs[index + direction], legs[index]];
    onChange({ ...draft, executions: legs });
  };
  return <article className="tl-editor">
    <header className="tl-editor-header">
      <div className="tl-editor-title"><h2>{draft.symbol.trim().toUpperCase() || "New trade"}</h2>{saved && <span>#{saved.id}</span>}</div>
      <div className="tl-actions">{summary && <Chip size="small" label={summary.status === "open" ? "Open position" : "Closed"} variant="outlined" />}
        {dirty && <Tooltip title="Draft retained in this browser tab. Save trade to persist your changes."><span className="tl-unsaved">Unsaved</span></Tooltip>}
        <Button size="small" disabled={busy || !dirty} onClick={onReset}>Discard</Button>
        <Button size="small" variant="contained" disabled={busy || !dirty || !preview} onClick={onSave}>{busy ? "Saving…" : "Save trade"}</Button>
        <IconButton size="small" aria-label="Close trade editor" disabled={busy} onClick={onClose}><CloseIcon fontSize="small" /></IconButton>
      </div>
    </header>
    <fieldset className="tl-fields" disabled={busy}>
      <div className="tl-identity"><TextField size="small" label="Ticker" value={draft.symbol} onChange={e => onChange({ ...draft, symbol: e.target.value })} slotProps={{ htmlInput: { maxLength: 32, autoCapitalize: "characters" } }} />
        <Tooltip title="Changing direction swaps buy and sell on every execution. Review the recalculated trade before saving."><TextField select size="small" label="Direction" value={draft.direction} onChange={e => changeDirection(e.target.value as TradeLogDirection)}><MenuItem value="long">Long</MenuItem><MenuItem value="short">Short</MenuItem></TextField></Tooltip>
        <TagPicker tags={tags} ids={draft.tag_ids} label="Trade tags" onChange={tag_ids => onChange({ ...draft, tag_ids })} disabled={busy} />
      </div>
      <div className="tl-summary">
        <Metric label="Remaining shares" value={summary ? shares(summary.remaining_quantity) : "—"} />
        <Metric label={short ? "Avg. entry · net of entry fees" : "Average cost · incl. entry fees"} value={money(summary?.average_cost)} />
        <Metric label="Realized P&L · after fees" value={money(summary?.realized_pnl)} className={summary ? pnlClass(summary.realized_pnl) : ""} />
        <Metric label="Total fees" value={money(summary?.fees)} />
      </div>
      {lastValidTrade && !preview && <p className="tl-caption">Position totals show the last valid calculation while you edit.</p>}
      <section className="tl-executions">
        <div className="tl-section-heading"><div className="tl-execution-heading"><h3>Executions <span className="tl-count">{draft.executions.length}</span></h3><Tooltip title="Execution times use your local timezone. Calculations follow chronological order; arrows set the order when timestamps match."><InfoOutlinedIcon className="tl-help-icon" fontSize="small" aria-label="About execution ordering" /></Tooltip></div>
          <div className="tl-actions"><Button size="small" startIcon={<AddIcon />} disabled={draft.executions.length >= 500} onClick={() => append(entrySide)}>{short ? "Add short" : "Add buy"}</Button><Button size="small" disabled={draft.executions.length >= 500} onClick={() => append(exitSide)}>{short ? "Add cover" : "Add sell"}</Button>
            <Button size="small" variant="outlined" disabled={!preview || summary?.status === "closed" || draft.executions.length >= 500} onClick={() => append(exitSide, true)}>Close remaining</Button></div>
        </div>
        {draft.executions.map((leg, index) => <div className="tl-leg" id={`tl-execution-${index}`} key={leg.id ?? `new-${index}`} role="group" aria-label={`Execution ${index + 1}`}>
          <span className={`tl-leg-number ${leg.side === "buy" ? "tl-buy" : "tl-sell"}`}>{String(index + 1).padStart(2, "0")}</span>
          <div className="tl-leg-inputs">
            <TextField select size="small" label="Side" value={leg.side} onChange={e => setLeg(index, { side: e.target.value as "buy" | "sell" })}><MenuItem value="buy">{short ? "Cover" : "Buy"}</MenuItem><MenuItem value="sell">{short ? "Short" : "Sell"}</MenuItem></TextField>
            <div className="tl-execution-datetime">
              <TextField size="small" type="date" label="Date" value={localDateTime(leg.executed_at).split("T")[0]} onChange={e => setLeg(index, { executed_at: `${e.target.value}T${localDateTime(leg.executed_at).split("T")[1] ?? ""}` })} slotProps={{ inputLabel: { shrink: true } }} />
              <TextField size="small" label="Time (24h)" placeholder="HH:mm" value={localDateTime(leg.executed_at).split("T")[1] ?? ""} onChange={e => setLeg(index, { executed_at: `${localDateTime(leg.executed_at).split("T")[0]}T${e.target.value}` })} slotProps={{ inputLabel: { shrink: true }, htmlInput: { maxLength: 5, pattern: "(?:[01][0-9]|2[0-3]):[0-5][0-9]" } }} />
            </div>
            {([['quantity', 'Shares'], ['price', 'Price · USD'], ['fee', 'Fee · USD']] as const).map(([field, label]) => <TextField key={field} size="small" label={label} value={leg[field]} onChange={e => setLeg(index, { [field]: e.target.value })} slotProps={{ htmlInput: { inputMode: "decimal" } }} />)}
          </div>
          <div className="tl-leg-actions"><Tooltip title="Move earlier for matching timestamps"><span><IconButton size="small" aria-label={`Move execution ${index + 1} up`} disabled={index === 0 || busy} onClick={() => move(index, -1)}><ArrowUpwardIcon fontSize="small" /></IconButton></span></Tooltip>
            <Tooltip title="Move later for matching timestamps"><span><IconButton size="small" aria-label={`Move execution ${index + 1} down`} disabled={index === draft.executions.length - 1 || busy} onClick={() => move(index, 1)}><ArrowDownwardIcon fontSize="small" /></IconButton></span></Tooltip>
            <IconButton size="small" aria-label={`Remove execution ${index + 1}`} disabled={busy} onClick={() => onChange({ ...draft, executions: draft.executions.filter((_, i) => i !== index) })}><DeleteOutlineIcon fontSize="small" /></IconButton>
          </div>
          <div className="tl-leg-detail"><TagPicker tags={tags} ids={leg.tag_ids} label="Execution tags" disabled={busy} onChange={tag_ids => setLeg(index, { tag_ids })} />
            <TextField size="small" label="Execution note" multiline maxRows={6} value={leg.notes} onChange={e => setLeg(index, { notes: e.target.value })} slotProps={{ htmlInput: { maxLength: 10000 } }} /></div>
        </div>)}
        {validation ? <Alert severity={dirty ? "warning" : "info"} className="tl-validation">{validation}</Alert> : !preview && <div className="tl-caption tl-preview-status"><CircularProgress size={12} /> Checking trade…</div>}
      </section>
      <section className="tl-journal"><div className="tl-section-heading"><h3>Journal</h3></div>
        <TextField multiline minRows={3} maxRows={20} fullWidth label="Trade notes" value={draft.notes} onChange={e => onChange({ ...draft, notes: e.target.value })} slotProps={{ htmlInput: { maxLength: 50000 } }} />
      </section>
    </fieldset>
    <footer className="tl-editor-footer"><span>USD · {short ? "Short position" : "Long position"} · Weighted average · Up to 6 decimal places</span>{saved && <Button size="small" color="error" disabled={busy} onClick={onDelete}>Delete trade</Button>}</footer>
  </article>;
}

function Metric({ label, value, className = "" }: { label: string; value: string | number; className?: string }) {
  return <div className="tl-metric"><span>{label}</span><strong className={className}>{value}</strong></div>;
}
