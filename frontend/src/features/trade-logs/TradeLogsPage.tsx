import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { isCancelledError, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Dialog, DialogActions, DialogContent, DialogTitle, IconButton, Tab, Tabs, TextField, Tooltip } from "@mui/material";
import AddIcon from "@mui/icons-material/Add";
import RefreshIcon from "@mui/icons-material/Refresh";
import { Toast } from "../../components/Toast";
import { DateRangePicker } from "../../components/DateRangePicker";
import { SplitPane } from "../../components/SplitPane";
import type { TradeLog, TradeLogFilters, TradeLogInput } from "../../api/tradeLogs";
import { deleteTradeLogMutationOptions, refreshTradeLogs, saveTradeLogMutationOptions, tradeLogQueryOptions } from "./tradeLogQuery";
import { useTradeLogsQuery } from "./useTradeLogsQuery";
import { TradeTable } from "./TradeTable";
import { TradeChartDrawer } from "./TradeChartDrawer";
import { useTradeValuations } from "./useTradeValuations";
import { TradeEditor } from "./TradeEditor";
import { TradeStatistics } from "./TradeStatistics";
import { TradeTags } from "./TradeTags";
import { TradeFilterSelect } from "./TradeFilterSelect";
import { restoreChartSplit, saveChartSplit } from "./chartLayout";
import { tradeIdFromSearch } from "./tradeLinks";
import { initialFilters, restoreFilters, saveFilters } from "./filterStorage";
import { draftFromTrade, errorMessage, newDraft, payload } from "./format";
import "./trade-logs.css";

const draftKey = "trade-logs-draft-v1";
const chartWidthKey = "market-watch.trade-logs-chart-width-percent";
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
  const [searchParams] = useSearchParams();
  const linkedTradeId = tradeIdFromSearch(searchParams);
  const [tab, setTab] = useState(0);
  const [visitedTabs, setVisitedTabs] = useState([0]);
  const [statisticsIncludeOpen, setStatisticsIncludeOpen] = useState(false);
  const [initialChartWidth] = useState(() => restoreChartSplit(chartWidthKey));
  const client = useQueryClient();
  const saveMutation = useMutation(saveTradeLogMutationOptions(client));
  const [selectedTradeId, setSelectedTradeId] = useState<number | null>(linkedTradeId ?? null);
  const deleteOptions = deleteTradeLogMutationOptions(client);
  const deleteMutation = useMutation({
    ...deleteOptions,
    onSuccess: async (...args) => {
      // Stop observing the deleted trade before journal refetches can render it again.
      setSelectedTradeId(current => current === args[1].id ? null : current);
      await deleteOptions.onSuccess?.(...args);
    },
  });
  const [filters, setFilters] = useState(() => linkedTradeId === undefined ? restoreFilters() : initialFilters);
  const [filterLinkId, setFilterLinkId] = useState(linkedTradeId);
  const [editor, setEditor] = useState<EditorState | null>(restoreDraft);
  const [openingEditor, setOpeningEditor] = useState(false);
  const editorRead = useRef(0);
  const busy = openingEditor || saveMutation.isPending || deleteMutation.isPending;
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [confirm, setConfirm] = useState<{ title: string; text: string; action: () => void; destructive?: boolean } | null>(null);
  // Switch filter context before rendering a new URL; late trade responses cannot reset user edits.
  if (filterLinkId !== linkedTradeId) {
    setFilterLinkId(linkedTradeId);
    setFilters(linkedTradeId === undefined ? restoreFilters() : initialFilters);
    setSelectedTradeId(linkedTradeId ?? null);
    if (linkedTradeId !== undefined) setTab(0);
  }
  const journal = useTradeLogsQuery(filters, linkedTradeId);
  const snapshot = journal.data ?? null;
  const loading = journal.loading;
  const loadError = journal.error ? errorMessage(journal.error) : "";
  const listedSelection = snapshot?.trades.find(trade => trade.id === selectedTradeId);
  const detail = useQuery({ ...tradeLogQueryOptions(selectedTradeId ?? undefined), placeholderData: listedSelection });
  const selected = listedSelection && (!detail.data || listedSelection.revision > detail.data.revision)
    ? listedSelection : detail.data ?? null;
  const detailError = detail.error ? errorMessage(detail.error) : "";
  const { marks, error: marketError, loading: marksLoading } = useTradeValuations(snapshot?.trades ?? [], tab === 0 || tab === 1 && statisticsIncludeOpen);
  const dirty = editor !== null && JSON.stringify(editor.draft) !== editor.baseline;
  const refreshData = useCallback(() => { void refreshTradeLogs(client); }, [client]);
  useEffect(() => () => { editorRead.current++; }, []);
  const changeTab = (value: number) => {
    setTab(value);
    setVisitedTabs(current => current.includes(value) ? current : [...current, value]);
  };
  // Persist user changes only; opening a trade link temporarily bypasses saved filters.
  const changeFilter = (patch: Partial<TradeLogFilters>) => {
    const next = { ...filters, ...patch };
    setFilters(next);
    saveFilters(next);
  };
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
  useEffect(() => {
    if (tab !== 0 || selectedTradeId === null) return;
    const dismissChart = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      event.preventDefault();
      setSelectedTradeId(null);
    };
    window.addEventListener("keydown", dismissChart);
    return () => window.removeEventListener("keydown", dismissChart);
  }, [tab, selectedTradeId]);
  const guarded = useCallback((action: () => void) => {
    if (busy) return;
    if (dirty) setConfirm({ title: "Discard unsaved changes?", text: "Your changes to this trade have not been saved.", action });
    else action();
  }, [busy, dirty]);
  const select = useCallback(async (id: number) => {
    const request = ++editorRead.current;
    setOpeningEditor(true); setError(""); setNotice("");
    try {
      const trade = await client.fetchQuery({ ...tradeLogQueryOptions(id), staleTime: 0 });
      if (editorRead.current === request) setEditor(editorFor(trade));
    } catch (cause) { if (editorRead.current === request && !isCancelledError(cause)) setError(errorMessage(cause)); }
    finally { if (editorRead.current === request) setOpeningEditor(false); }
  }, [client]);
  const selectTrade = useCallback((trade: TradeLog) => setSelectedTradeId(current => current === trade.id ? null : trade.id), []);
  const editTrade = useCallback((trade: TradeLog) => guarded(() => void select(trade.id)), [guarded, select]);
  const closeChart = useCallback(() => setSelectedTradeId(null), []);
  const create = () => guarded(() => { const draft = newDraft(); setEditor({ saved: null, draft, baseline: JSON.stringify(draft) }); setTab(0); setError(""); setNotice(""); });
  const save = async () => {
    if (!editor || busy) return;
    setError("");
    try {
      await saveMutation.mutateAsync({ id: editor.saved?.id ?? null, input: payload(editor.draft) });
      setEditor(null); setNotice("Trade saved.");
    } catch (cause) { setError(errorMessage(cause)); }
  };
  const remove = async () => {
    if (!editor?.saved || busy) return;
    setError("");
    try {
      await deleteMutation.mutateAsync(editor.saved);
      setEditor(null); setNotice("Trade deleted.");
    } catch (cause) { setError(errorMessage(cause)); }
  };
  const currentSaved = snapshot?.trades.find(trade => trade.id === editor?.saved?.id);
  const changed = currentSaved && editor?.saved && currentSaved.revision > editor.saved.revision;
  return <div className="trade-logs-page trade-logs-ui" aria-busy={loading || marksLoading}>
    <header className="tl-page-header">
      <h1>Trade Logs</h1>
      <Tabs value={tab} onChange={(_, value: number) => changeTab(value)} aria-label="Trade Logs sections" className="tl-tabs">
        {["Trades", "Statistics", "Tags"].map((label, index) => <Tab key={label} label={label} id={`tl-tab-${index}`} aria-controls={`tl-panel-${index}`} />)}
      </Tabs>
      {tab !== 2 && <div className="tl-filters" role="group" aria-label="Trade filters">
        <TextField size="small" label="Find ticker" value={filters.symbol} onChange={e => changeFilter({ symbol: e.target.value })} />
        <TradeFilterSelect<TradeLogFilters["status"][number]> label="Status" hint="Match any selected status. Win and Loss refer to closed trades after fees. Statistics includes closed trades by default; use Include open trades to add valued open positions." values={filters.status} options={[{ value: "open", label: "Open" }, { value: "closed", label: "Closed" }, { value: "win", label: "Win" }, { value: "loss", label: "Loss" }]} onChange={status => changeFilter({ status })} />
        <TradeFilterSelect<TradeLogFilters["direction"][number]> label="Side" hint="Long: buy first, then sell. Short: sell first, then buy back. Leave empty to include both." values={filters.direction} options={[{ value: "long", label: "Long" }, { value: "short", label: "Short" }]} onChange={direction => changeFilter({ direction })} />
        <TradeFilterSelect label="Tag" className="tl-filter-tag" hint="Include trades with any selected tag. This global filter also defines the comparison population in Statistics." values={filters.tag_id}
          options={[...(snapshot?.tags ?? []).map(tag => ({ value: tag.id, label: tag.name })), ...filters.tag_id.filter(id => !snapshot?.tags.some(tag => tag.id === id)).map(id => ({ value: id, label: `Deleted tag #${id}` }))]}
          onChange={tag_id => changeFilter({ tag_id })} />
        <TradeFilterSelect<TradeLogFilters["tag_scope"][number]> label="Tag source" className="tl-filter-scope" hint="Choose where to look for tags: the whole trade, its executions, or both. Empty means both. A matching execution associates the whole trade with that tag." values={filters.tag_scope} options={[{ value: "trade", label: "Trade tags" }, { value: "leg", label: "Execution tags" }]} onChange={tag_scope => changeFilter({ tag_scope })} />
        <DateRangePicker start={filters.start} end={filters.end} onChange={(start, end) => changeFilter({ start, end })} />
        <Button size="small" onClick={() => changeFilter(initialFilters)}>Reset</Button>
      </div>}
      <div className="tl-actions"><Tooltip title="Refresh journal and tag library"><span><IconButton size="small" disabled={loading || busy} aria-label="Refresh trade logs" onClick={refreshData}><RefreshIcon fontSize="small" /></IconButton></span></Tooltip><Button variant="contained" size="small" startIcon={<AddIcon />} disabled={busy} onClick={create}>New trade</Button></div>
    </header>
    {error && !editor && <Alert severity="error" onClose={() => setError("")}>{error}</Alert>}
    {detailError && <Alert severity="error" action={<Button onClick={() => void detail.refetch()}>Retry</Button>}>{detailError}</Alert>}
    <Toast message={notice || undefined} severity="success" onClose={() => setNotice("")} />
    {loadError && <Alert severity="error" action={<Button onClick={refreshData}>Retry</Button>}>{loadError}{snapshot && " Previous results remain visible."}</Alert>}

    <div role="tabpanel" hidden={tab !== 0} id="tl-panel-0" aria-labelledby="tl-tab-0">
      {marketError && <Alert severity="warning">Open-position prices could not refresh. Check the valuation dates before using the displayed returns.</Alert>}
      <div className="tl-trade-layout">
        <SplitPane orientation="horizontal" initialSplit={100 - initialChartWidth} secondVisible={selected !== null} onSplitChange={split => saveChartSplit(chartWidthKey, 100 - split)}
          first={<TradeTable trades={snapshot?.trades ?? []} tags={snapshot?.tags ?? []} marks={marks} selectedId={selected?.id ?? null} loading={loading && !snapshot?.trades.length} onSelect={selectTrade} onEdit={editTrade} />}
          second={<TradeChartDrawer trade={selected} tags={snapshot?.tags ?? []} timeZone={snapshot?.time_zone ?? null} onClose={closeChart} onEdit={editTrade} />} />
      </div>
    </div>
    <div role="tabpanel" hidden={tab !== 1} id="tl-panel-1" aria-labelledby="tl-tab-1">{visitedTabs.includes(1) && (snapshot ? <TradeStatistics snapshot={snapshot} tagScope={filters.tag_scope} marks={marks} marksLoading={marksLoading} marketError={marketError} includeOpen={statisticsIncludeOpen} onIncludeOpen={setStatisticsIncludeOpen} onRetryPrices={refreshData} /> : <div className="tl-empty-small">{loading ? "Loading statistics…" : "Statistics could not be loaded."}</div>)}</div>
    <div role="tabpanel" hidden={tab !== 2} id="tl-panel-2" aria-labelledby="tl-tab-2">{visitedTabs.includes(2) && <TradeTags tags={snapshot?.tags ?? []} />}</div>
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
