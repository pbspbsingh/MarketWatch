import { useEffect, useState } from "react";
import AddIcon from "@mui/icons-material/Add";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutlined";
import EditOutlinedIcon from "@mui/icons-material/EditOutlined";
import RefreshIcon from "@mui/icons-material/Refresh";
import {
  Button, Checkbox, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle,
  FormControlLabel, IconButton, MenuItem, Select, TextField, Tooltip, Typography,
} from "@mui/material";
import {
  clearTopStocks, createTopStockScreen, deleteTopStockScreen, fetchTopStockScreens,
  fetchTopStocks, refreshTopStocks, replaceTopStocks, updateTopStockScreen,
  type TopStockScreen, type TopStockScreenInput, type TopStocksPeriod,
  type TopStocksSelection, type TopStocksSnapshot, type TopStocksSource,
} from "../../api/topStocks";
import { Toast } from "../../components/Toast";
import { TickerLens } from "../ticker-lens/TickerLens";
import "./top-stocks.css";

const periods: { period: TopStocksPeriod; label: string }[] = [
  { period: "week1", label: "1 Week" }, { period: "month1", label: "1 Month" },
  { period: "months3", label: "3 Months" }, { period: "months6", label: "6 Months" },
  { period: "year1", label: "1 Year" },
];
const defaultCount = 200;
const periodMode = "periods";

export function TopStocksPage() {
  const [snapshot, setSnapshot] = useState<TopStocksSnapshot | null>();
  const [screens, setScreens] = useState<TopStockScreen[]>([]);
  const [periodSelections, setPeriodSelections] = useState<TopStocksSelection[]>([]);
  const [draftCount, setDraftCount] = useState(String(defaultCount));
  const [applyAdditionalFilters, setApplyAdditionalFilters] = useState(false);
  const [loading, setLoading] = useState(true);
  const [screenMenuOpen, setScreenMenuOpen] = useState(false);
  const [editor, setEditor] = useState<TopStockScreen | null>();
  const [deleteTarget, setDeleteTarget] = useState<TopStockScreen>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([fetchTopStocks(controller.signal), fetchTopStockScreens(controller.signal)])
      .then(([nextSnapshot, nextScreens]) => {
        if (controller.signal.aborted) return;
        setScreens(nextScreens);
        const source = nextSnapshot?.source;
        const validSnapshot = source?.kind !== "custom_screen"
          || nextScreens.some((screen) => screen.id === source.screen_id) ? nextSnapshot : null;
        setSnapshot(validSnapshot);
        const rememberedSelections = nextSnapshot?.period_selections ?? [];
        setApplyAdditionalFilters(nextSnapshot?.period_apply_additional_filters ?? false);
        setPeriodSelections(rememberedSelections);
        if (rememberedSelections.length > 0) {
          setDraftCount(String(rememberedSelections[0].count));
        }
      })
      .catch((requestError: unknown) => { if (!controller.signal.aborted) { setSnapshot(null); setError(message(requestError)); } })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, []);

  const selections = periodSelections;
  const snapshotSource = snapshot?.source;
  const selectedScreen = snapshotSource?.kind === "custom_screen"
    ? screens.find((screen) => screen.id === snapshotSource.screen_id) : undefined;
  const selectedMode = selectedScreen === undefined ? periodMode : String(selectedScreen.id);
  const save = async (source: TopStocksSource) => {
    setLoading(true); setError(undefined);
    try {
      const next = await replaceTopStocks(source);
      setSnapshot(next);
      setPeriodSelections(next.period_selections);
      setApplyAdditionalFilters(next.period_apply_additional_filters);
    }
    catch (requestError) { setError(message(requestError)); }
    finally { setLoading(false); }
  };
  const countForPeriods = () => {
    const value = Number(draftCount);
    return Number.isInteger(value) && value > 0 ? value : defaultCount;
  };
  const selectionsWithCount = (items: TopStocksSelection[], count = countForPeriods()) =>
    items.map((item) => ({ ...item, count }));
  const periodSource = (items: TopStocksSelection[], filters = applyAdditionalFilters): TopStocksSource => ({
    kind: "periods",
    selections: items,
    apply_additional_filters: filters,
  });

  const saveScreen = async (input: TopStockScreenInput) => {
    try {
      const saved = editor === null ? await createTopStockScreen(input) : await updateTopStockScreen(editor!.id, input);
      setScreens((current) => (editor === null ? [...current, saved] : current.map((item) => item.id === saved.id ? saved : item)).sort(compareScreens));
      setEditor(undefined);
      await save({ kind: "custom_screen", screen_id: saved.id });
    } catch (requestError) { setError(message(requestError)); }
  };

  const removeScreen = async () => {
    if (deleteTarget === undefined) return;
    try {
      await deleteTopStockScreen(deleteTarget.id);
      setScreens((current) => current.filter((screen) => screen.id !== deleteTarget.id));
      if (snapshot?.source.kind === "custom_screen" && snapshot.source.screen_id === deleteTarget.id) setSnapshot(null);
      setDeleteTarget(undefined);
    } catch (requestError) { setError(message(requestError)); }
  };

  return (
    <section className="workspace-panel top-stocks-page" aria-label="Top Stocks">
      <header className="panel-header top-stocks-header">
        <Typography component="h1">Top Stocks</Typography>
        <div className="top-stocks-actions"><div className="top-stocks-controls">
          {loading && <CircularProgress size="0.8rem" />}
          {selectedMode === periodMode && <TextField className="top-stocks-period-count" size="small" type="number" value={draftCount} disabled={loading}
            slotProps={{ htmlInput: { min: 1, max: 1000, "aria-label": "Stock count" } }}
            onChange={(event) => setDraftCount(event.target.value)}
            onBlur={() => {
              const count = countForPeriods();
              setDraftCount(String(count));
              if (selections.some((item) => item.count !== count)) void save(periodSource(selectionsWithCount(selections, count)));
            }} />}
          {selectedMode === periodMode && <FormControlLabel className="top-stocks-additional-filters"
            control={<Checkbox size="small" checked={applyAdditionalFilters} disabled={loading}
              onChange={(event) => {
                const checked = event.target.checked;
                setApplyAdditionalFilters(checked);
                void save(periodSource(selections, checked));
              }} />}
            label="Additional Filters" />}
          {selectedMode === periodMode && periods.map(({ period, label }) => (
            <div className="top-stocks-period" key={period}>
              <FormControlLabel control={<Checkbox size="small" checked={selections.some((item) => item.period === period)} disabled={loading}
                onChange={(event) => void save(periodSource(event.target.checked
                  ? [...selectionsWithCount(selections), { period, count: countForPeriods() }]
                  : selections.filter((item) => item.period !== period)))} />} label={label} />
            </div>
          ))}
          <div className="top-stocks-screen-controls">
            <Select size="small" value={selectedMode} disabled={loading} aria-label="Top stocks source"
              open={screenMenuOpen} onOpen={() => setScreenMenuOpen(true)} onClose={() => setScreenMenuOpen(false)}
              renderValue={(value) => value === periodMode
                ? "Performance periods"
                : screens.find((screen) => String(screen.id) === value)?.name ?? "Custom screen"}
              onChange={(event) => void save(event.target.value === periodMode
                ? periodSource(selections)
                : { kind: "custom_screen", screen_id: Number(event.target.value) })}>
              <MenuItem value={periodMode}>Performance periods</MenuItem>
              {screens.map((screen) => <MenuItem key={screen.id} value={String(screen.id)} className="top-stocks-screen-option">
                <span>{screen.name}</span>
                <span className="top-stocks-screen-option-actions">
                  <Tooltip title="Edit custom screen"><IconButton size="small" onClick={(event) => {
                    event.stopPropagation(); setScreenMenuOpen(false); setEditor(screen);
                  }}><EditOutlinedIcon fontSize="small" /></IconButton></Tooltip>
                  <Tooltip title="Delete custom screen"><IconButton size="small" onClick={(event) => {
                    event.stopPropagation(); setScreenMenuOpen(false); setDeleteTarget(screen);
                  }}><DeleteOutlineIcon fontSize="small" /></IconButton></Tooltip>
                </span>
              </MenuItem>)}
            </Select>
            <Tooltip title="Add custom screen"><IconButton size="small" disabled={loading} onClick={() => setEditor(null)}><AddIcon fontSize="small" /></IconButton></Tooltip>
          </div>
          <div className="top-stocks-action-buttons">
            <Tooltip title="Refresh top stocks"><span><IconButton size="small" disabled={loading || snapshot === null} onClick={() => {
              setLoading(true); void refreshTopStocks().then((next) => {
                setSnapshot(next);
                if (next !== null) {
                  setPeriodSelections(next.period_selections);
                  setApplyAdditionalFilters(next.period_apply_additional_filters);
                }
              }).catch((requestError: unknown) => setError(message(requestError))).finally(() => setLoading(false));
            }}><RefreshIcon fontSize="small" /></IconButton></span></Tooltip>
            <Tooltip title="Clear top stocks"><span><IconButton size="small" disabled={loading || snapshot === null} onClick={() => {
              setLoading(true); void clearTopStocks().then(() => setSnapshot(null)).catch((requestError: unknown) => setError(message(requestError))).finally(() => setLoading(false));
            }}><DeleteOutlineIcon fontSize="small" /></IconButton></span></Tooltip>
          </div>
        </div></div>
      </header>
      {snapshot === undefined ? <div className="panel-status"><CircularProgress size="1rem" /></div>
        : snapshot === null || snapshot.symbols.length === 0 ? <div className="panel-status"><Typography color="text.secondary">Select a source to load top stocks</Typography></div>
        : <TickerLens accent="green" universe={{ type: "bounded", symbols: snapshot.symbols }} />}
      {editor !== undefined && <ScreenEditor screen={editor} onClose={() => setEditor(undefined)} onSave={saveScreen} />}
      <Dialog open={deleteTarget !== undefined} onClose={() => setDeleteTarget(undefined)}>
        <DialogTitle>Delete custom screen?</DialogTitle><DialogContent><Typography>This permanently deletes {deleteTarget?.name}.</Typography></DialogContent>
        <DialogActions><Button onClick={() => setDeleteTarget(undefined)}>Cancel</Button><Button color="error" onClick={() => void removeScreen()}>Delete</Button></DialogActions>
      </Dialog>
      <Toast message={error} onClose={() => setError(undefined)} />
    </section>
  );
}

function ScreenEditor({ screen, onClose, onSave }: { screen: TopStockScreen | null; onClose: () => void; onSave: (input: TopStockScreenInput) => Promise<void> }) {
  const [name, setName] = useState(screen?.name ?? "");
  const [url, setUrl] = useState(screen?.url ?? "");
  const [count, setCount] = useState(String(screen?.max_stock_count ?? defaultCount));
  const parsedCount = Number(count);
  const valid = name.trim() !== "" && url.trim() !== "" && Number.isInteger(parsedCount) && parsedCount >= 1 && parsedCount <= 500;
  return <Dialog open onClose={onClose} maxWidth="sm" fullWidth>
    <DialogTitle>{screen === null ? "Add custom screen" : "Edit custom screen"}</DialogTitle>
    <DialogContent className="top-stocks-screen-editor">
      <TextField label="Unique name" value={name} onChange={(event) => setName(event.target.value)} slotProps={{ htmlInput: { maxLength: 100 } }} autoFocus />
      <TextField label="Finviz screener URL" value={url} onChange={(event) => setUrl(event.target.value)} />
      <TextField label="Maximum stocks" type="number" value={count} onChange={(event) => setCount(event.target.value)} slotProps={{ htmlInput: { min: 1, max: 500 } }} />
    </DialogContent>
    <DialogActions><Button onClick={onClose}>Cancel</Button><Button disabled={!valid} onClick={() => void onSave({ name: name.trim(), url: url.trim(), max_stock_count: parsedCount })}>Save</Button></DialogActions>
  </Dialog>;
}

function compareScreens(left: TopStockScreen, right: TopStockScreen) { return left.name.localeCompare(right.name, undefined, { sensitivity: "base" }); }
function message(error: unknown) { return error instanceof Error ? error.message : "Top stocks request failed"; }
