import { useEffect, useState } from "react";
import { Alert, Button, Dialog, DialogActions, DialogContent, DialogTitle, IconButton, Tab, Tabs, TextField, Tooltip } from "@mui/material";
import AddIcon from "@mui/icons-material/Add";
import RefreshIcon from "@mui/icons-material/Refresh";
import { Toast } from "../../components/Toast";
import { DateRangePicker } from "../../components/DateRangePicker";
import { deleteTradeLog, fetchTradeLog, fetchTradeLogs, saveTradeLog, type TradeLog, type TradeLogFilters, type TradeLogInput, type TradeLogSnapshot } from "../../api/tradeLogs";
import { useFocusRefresh } from "../../shared/useFocusRefresh";
import { TradeTable } from "./TradeTable";
import { TradeChartDrawer } from "./TradeChartDrawer";
import { useTradeValuations } from "./useTradeValuations";
import { TradeEditor } from "./TradeEditor";
import { TradeStatistics } from "./TradeStatistics";
import { TradeTags } from "./TradeTags";
import { TradeFilterSelect } from "./TradeFilterSelect";
import { draftFromTrade, errorMessage, newDraft, payload } from "./format";
import "./trade-logs.css";

const draftKey = "trade-logs-draft-v1";
const initialFilters: TradeLogFilters = { symbol: "", direction: [], status: [], tag_id: [], tag_scope: [], start: "", end: "" };
interface EditorState { saved: TradeLog | null; draft: TradeLogInput; baseline: string }
function restoreDraft(): EditorState | null {
  try {
    const raw = sessionStorage.getItem(draftKey);
    if (!raw) return null;
    const value = JSON.parse(raw) as EditorState;
    if (typeof value.baseline === "string" && typeof value.draft?.symbol === "string" && Array.isArray(value.draft.executions) && Array.isArray(value.draft.tag_ids)) return { ...value, draft: { ...value.draft, direction: value.draft.direction ?? "long" } };
  } catch { /* An unavailable or malformed browser draft must not block the journal. */ }
  return null;
}
function editorFor(trade: TradeLog): EditorState {
  const draft = draftFromTrade(trade);
  return { saved: trade, draft, baseline: JSON.stringify(draft) };
}

export function TradeLogsPage() {
  const [tab, setTab] = useState(0);
  const focusRefresh = useFocusRefresh();
  const [selectedTrade, setSelectedTrade] = useState<TradeLog | null>(null);
  const [filters, setFilters] = useState(initialFilters);
  const [snapshot, setSnapshot] = useState<TradeLogSnapshot | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(restoreDraft);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [notice, setNotice] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [confirm, setConfirm] = useState<{ title: string; text: string; action: () => void; destructive?: boolean } | null>(null);
  const { marks, error: marketError, loading: marksLoading } = useTradeValuations(snapshot?.trades ?? [], refresh + focusRefresh, tab === 0);
  const dirty = editor !== null && JSON.stringify(editor.draft) !== editor.baseline;
  const refreshData = () => setRefresh(n => n + 1);
  const changeFilter = (patch: Partial<TradeLogFilters>) => setFilters(current => ({ ...current, ...patch }));
  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setLoading(true);
      void fetchTradeLogs(filters, controller.signal)
        .then(value => { if (!controller.signal.aborted) { setSnapshot(value); setLoadError(""); } })
        .catch(cause => { if (!controller.signal.aborted) setLoadError(errorMessage(cause)); })
        .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, 200);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [filters, refresh, focusRefresh]);
  useEffect(() => {
    try {
      if (dirty) sessionStorage.setItem(draftKey, JSON.stringify(editor));
      else sessionStorage.removeItem(draftKey);
    } catch { /* Saving to the server remains available if browser storage is full. */ }
  }, [editor, dirty]);
  useEffect(() => {
    if (!dirty && !busy) return;
    const unload = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    const navigate = (event: MouseEvent) => {
      const anchor = (event.target as Element).closest?.("a[href]");
      if (!(anchor instanceof HTMLAnchorElement) || anchor.target === "_blank" || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      if (anchor.origin !== location.origin || anchor.pathname !== location.pathname) {
        if (busy || !window.confirm("Leave Trade Logs with unsaved changes? Your draft will remain in this browser tab.")) { event.preventDefault(); event.stopPropagation(); }
      }
    };
    window.addEventListener("beforeunload", unload);
    document.addEventListener("click", navigate, true);
    return () => { window.removeEventListener("beforeunload", unload); document.removeEventListener("click", navigate, true); };
  }, [dirty, busy]);
  const guarded = (action: () => void) => {
    if (busy) return;
    if (dirty) setConfirm({ title: "Discard unsaved changes?", text: "Your changes to this trade have not been saved.", action });
    else action();
  };
  const select = async (id: number) => {
    setBusy(true); setError(""); setNotice("");
    try { setEditor(editorFor(await fetchTradeLog(id))); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  };
  const create = () => guarded(() => { const draft = newDraft(); setEditor({ saved: null, draft, baseline: JSON.stringify(draft) }); setTab(0); setError(""); setNotice(""); });
  const save = async () => {
    if (!editor || busy) return;
    setBusy(true); setError("");
    try {
      const saved = await saveTradeLog(editor.saved?.id ?? null, payload(editor.draft));
      setEditor(null); setSelectedTrade(current => current?.id === saved.id ? saved : current); setSnapshot(current => current && { ...current, trades: current.trades.map(trade => trade.id === saved.id ? saved : trade) }); setNotice("Trade saved."); refreshData();
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  };
  const remove = async () => {
    if (!editor?.saved || busy) return;
    setBusy(true); setError("");
    try { await deleteTradeLog(editor.saved.id, editor.saved.revision); setSelectedTrade(current => current?.id === editor.saved!.id ? null : current); setEditor(null); setNotice("Trade deleted."); refreshData(); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  };
  const currentSaved = snapshot?.trades.find(trade => trade.id === editor?.saved?.id);
  const changed = currentSaved && editor?.saved && currentSaved.revision > editor.saved.revision;
  const refreshedSelection = snapshot?.trades.find(trade => trade.id === selectedTrade?.id);
  const selected = refreshedSelection && selectedTrade && refreshedSelection.revision > selectedTrade.revision ? refreshedSelection : selectedTrade;
  return <div className="trade-logs-page trade-logs-ui" aria-busy={loading || marksLoading}>
    <header className="tl-page-header">
      <h1>Trade Logs</h1>
      <Tabs value={tab} onChange={(_, value: number) => setTab(value)} aria-label="Trade Logs sections" className="tl-tabs">
        {["Trades", "Statistics", "Tags"].map((label, index) => <Tab key={label} label={label} id={`tl-tab-${index}`} aria-controls={`tl-panel-${index}`} />)}
      </Tabs>
      <div className="tl-actions"><Tooltip title="Refresh journal and tag library"><span><IconButton size="small" disabled={loading || busy} aria-label="Refresh trade logs" onClick={refreshData}><RefreshIcon fontSize="small" /></IconButton></span></Tooltip><Button variant="contained" size="small" startIcon={<AddIcon />} disabled={busy} onClick={create}>New trade</Button></div>
    </header>
    {error && !editor && <Alert severity="error" onClose={() => setError("")}>{error}</Alert>}
    <Toast message={notice || undefined} severity="success" onClose={() => setNotice("")} />
    {loadError && <Alert severity="error" action={<Button onClick={refreshData}>Retry</Button>}>{loadError}{snapshot && " Previous results remain visible."}</Alert>}

    {tab !== 2 && <div className="tl-filters">
      <TextField size="small" label="Find ticker" value={filters.symbol} onChange={e => changeFilter({ symbol: e.target.value })} />
      <TradeFilterSelect<TradeLogFilters["status"][number]> label="Status" values={filters.status} options={[{ value: "open", label: "Open" }, { value: "closed", label: "Closed" }, { value: "win", label: "Win" }, { value: "loss", label: "Loss" }]} onChange={status => changeFilter({ status })} />
      <TradeFilterSelect<TradeLogFilters["direction"][number]> label="Side" values={filters.direction} options={[{ value: "long", label: "Long" }, { value: "short", label: "Short" }]} onChange={direction => changeFilter({ direction })} />
      <TradeFilterSelect label="Tag" className="tl-filter-tag" values={filters.tag_id}
        options={[...(snapshot?.tags ?? []).map(tag => ({ value: tag.id, label: tag.name })), ...filters.tag_id.filter(id => !snapshot?.tags.some(tag => tag.id === id)).map(id => ({ value: id, label: `Deleted tag #${id}` }))]}
        onChange={tag_id => changeFilter({ tag_id })} />
      <TradeFilterSelect<TradeLogFilters["tag_scope"][number]> label="Tag source" className="tl-filter-scope" values={filters.tag_scope} options={[{ value: "trade", label: "Trade tags" }, { value: "leg", label: "Execution tags" }]} onChange={tag_scope => changeFilter({ tag_scope })} />
      <DateRangePicker start={filters.start} end={filters.end} onChange={(start, end) => changeFilter({ start, end })} />
      <Button size="small" onClick={() => setFilters(initialFilters)}>Reset</Button>
    </div>}
    <div role="tabpanel" hidden={tab !== 0} id="tl-panel-0" aria-labelledby="tl-tab-0">
      {marketError && <Alert severity="warning">Open-position prices could not refresh. Check the valuation dates before using the displayed returns.</Alert>}
      <div className="tl-trade-layout">
        <TradeTable trades={snapshot?.trades ?? []} tags={snapshot?.tags ?? []} marks={marks} selectedId={selected?.id ?? null} loading={loading} onSelect={trade => setSelectedTrade(current => current?.id === trade.id ? null : trade)} onEdit={trade => guarded(() => void select(trade.id))} />
        <TradeChartDrawer trade={selected} onClose={() => setSelectedTrade(null)} onEdit={trade => guarded(() => void select(trade.id))} />
      </div>
    </div>
    <div role="tabpanel" hidden={tab !== 1} id="tl-panel-1" aria-labelledby="tl-tab-1">{snapshot ? <TradeStatistics snapshot={snapshot} onTag={id => { changeFilter({ tag_id: [id] }); setTab(0); }} /> : <div className="tl-empty-small">{loading ? "Loading statistics…" : "Statistics could not be loaded."}</div>}</div>
    <div role="tabpanel" hidden={tab !== 2} id="tl-panel-2" aria-labelledby="tl-tab-2"><TradeTags tags={snapshot?.tags ?? []} onRefresh={refreshData} /></div>
    <Dialog open={editor !== null} onClose={() => guarded(() => setEditor(null))} fullWidth maxWidth="lg" aria-label={editor?.saved ? "Edit trade" : "New trade"} slotProps={{ paper: { className: "trade-logs-ui tl-editor-dialog" } }}>
      <DialogContent className="tl-editor-dialog-content">
        {changed && <Alert severity="warning" action={<Button disabled={busy} onClick={() => guarded(() => void select(currentSaved.id))}>Reload saved</Button>}>This trade changed since you opened it. Reload before saving further edits.</Alert>}
        {error && <Alert severity="error" action={editor?.saved && <Button size="small" disabled={busy} onClick={() => guarded(() => void select(editor.saved!.id))}>Reload saved</Button>}>{error}</Alert>}
        {editor && <TradeEditor key={editor.saved?.id ?? "new"} draft={editor.draft} saved={editor.saved} tags={snapshot?.tags ?? []} dirty={dirty} busy={busy}
          onChange={draft => { setNotice(""); setEditor(current => current && { ...current, draft }); }} onSave={() => void save()}
          onClose={() => guarded(() => setEditor(null))} onReset={() => guarded(() => { if (editor.saved) void select(editor.saved.id); else setEditor(null); })}
          onDelete={() => setConfirm({ title: `Delete ${editor.saved?.symbol} trade?`, text: "This permanently deletes the trade, its executions, notes, and tag assignments.", action: () => void remove(), destructive: true })} />}
      </DialogContent>
    </Dialog>
    <Dialog open={confirm !== null} onClose={() => setConfirm(null)} fullWidth maxWidth="xs"><DialogTitle>{confirm?.title}</DialogTitle><DialogContent>{confirm?.text}</DialogContent><DialogActions><Button onClick={() => setConfirm(null)}>Cancel</Button><Button color={confirm?.destructive ? "error" : "primary"} onClick={() => { const action = confirm?.action; setConfirm(null); action?.(); }}>{confirm?.destructive ? "Delete trade" : "Discard changes"}</Button></DialogActions></Dialog>
  </div>;
}
