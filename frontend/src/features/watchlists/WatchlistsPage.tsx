import { useEffect, useMemo, useRef, useState } from "react";
import AddIcon from "@mui/icons-material/Add";
import ArrowForwardIcon from "@mui/icons-material/ArrowForward";
import DeleteOutlinedIcon from "@mui/icons-material/DeleteOutlined";
import EditOutlinedIcon from "@mui/icons-material/EditOutlined";
import FileDownloadIcon from "@mui/icons-material/FileDownload";
import {
  Button,
  Checkbox,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  IconButton,
  InputAdornment,
  MenuItem,
  Select,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import { useNavigate, useParams } from "react-router-dom";
import { fetchNextTradingDay } from "../../api/market";
import { fetchThemeTicker } from "../../api/themes";
import {
  addTickerToWatchlist,
  createWatchlist,
  deleteWatchlist,
  fetchWatchlists,
  fetchWatchlistSymbols,
  updateWatchlist,
  type Watchlist,
} from "../../api/watchlists";
import { Toast } from "../../components/Toast";
import { useFocusRefresh } from "../../shared/useFocusRefresh";
import { TickerLens } from "../ticker-lens/TickerLens";
import { TickerStrengthControls } from "../ticker-strength/TickerStrengthControls";
import { TickerStrengthProvider } from "../ticker-strength/TickerStrengthContext";
import { useTickerStrengthFeature } from "../ticker-strength/useTickerStrengthMetric";
import { WatchlistIcon, watchlistIcons } from "./WatchlistIcon";
import "./watchlists.css";

const selectedWatchlistStorageKey = "market-watch.selected-watchlist";

export function WatchlistsPage() {
  return (
    <TickerStrengthProvider>
      <WatchlistsContent />
    </TickerStrengthProvider>
  );
}

function WatchlistsContent() {
  const { id } = useParams();
  const navigate = useNavigate();
  const tickerStrength = useTickerStrengthFeature();
  const focusRevision = useFocusRefresh();
  const [watchlists, setWatchlists] = useState<Watchlist[]>([]);
  const [symbols, setSymbols] = useState<string[]>([]);
  const [symbolsSelectionKey, setSymbolsSelectionKey] = useState("");
  const [loadedSymbolsRequestKey, setLoadedSymbolsRequestKey] = useState("");
  const [loading, setLoading] = useState(true);
  const [downloading, setDownloading] = useState(false);
  const [addingTicker, setAddingTicker] = useState(false);
  const [tickerInput, setTickerInput] = useState("");
  const [editor, setEditor] = useState<Watchlist | null | undefined>();
  const [deleteTarget, setDeleteTarget] = useState<Watchlist>();
  const [error, setError] = useState<string>();
  const selectedIds = useMemo(() => parseSelectedWatchlistIds(id), [id]);
  const selectionKey = serializeWatchlistIds(selectedIds);
  const selectionKeyRef = useRef(selectionKey);
  const selectedIdSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const selectedWatchlists = watchlists.filter((watchlist) => selectedIdSet.has(watchlist.id));
  const selectionReady = selectedIds.length > 0 && selectedWatchlists.length === selectedIds.length;
  const soleSelected = selectedWatchlists.length === 1 ? selectedWatchlists[0] : undefined;
  const symbolsRequestKey = !selectionReady
    ? undefined
    : `${selectionKey}\0${focusRevision}`;
  const symbolsLoading = symbolsRequestKey !== undefined
    && loadedSymbolsRequestKey !== symbolsRequestKey;
  useEffect(() => {
    selectionKeyRef.current = selectionKey;
  }, [selectionKey]);

  useEffect(() => {
    const controller = new AbortController();
    fetchWatchlists(controller.signal)
      .then((items) => {
        if (controller.signal.aborted) return;
        setWatchlists(items);
        const availableIds = new Set(items.map((item) => item.id));
        const requestedIds = parseSelectedWatchlistIds(id).filter((itemId) => availableIds.has(itemId));
        const storedIds = id === undefined
          ? readSelectedWatchlistIds().filter((itemId) => availableIds.has(itemId))
          : [];
        const nextIds = requestedIds.length > 0
          ? requestedIds
          : storedIds.length > 0
            ? storedIds
            : items[0] === undefined ? [] : [items[0].id];
        const nextKey = serializeWatchlistIds(nextIds);
        if (nextKey !== "" && nextKey !== id) {
          navigate(watchlistsPath(nextIds), { replace: true });
        }
      })
      .catch((requestError: unknown) => {
        if (!controller.signal.aborted) setError(message(requestError));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [focusRevision, id, navigate]);

  useEffect(() => {
    if (selectionReady) {
      localStorage.setItem(selectedWatchlistStorageKey, selectionKey);
    }
  }, [selectionKey, selectionReady]);

  useEffect(() => {
    if (!selectionReady || symbolsRequestKey === undefined) return;
    const controller = new AbortController();
    fetchWatchlistSymbols(selectedIds, controller.signal)
      .then((items) => {
        if (!controller.signal.aborted) {
          setSymbols(items);
          setSymbolsSelectionKey(selectionKey);
          setLoadedSymbolsRequestKey(symbolsRequestKey);
        }
      })
      .catch((requestError: unknown) => {
        if (!controller.signal.aborted) {
          setLoadedSymbolsRequestKey(symbolsRequestKey);
          setError(message(requestError));
        }
      });
    return () => controller.abort();
  }, [selectedIds, selectionKey, selectionReady, symbolsRequestKey]);

  const saveWatchlist = async (name: string, iconKey: string) => {
    try {
      const saved = editor === null
        ? await createWatchlist({ name, icon_key: iconKey })
        : await updateWatchlist(editor!.id, { name, icon_key: iconKey });
      setWatchlists((current) => editor === null
        ? [...current, saved].sort(compareWatchlists)
        : current.map((item) => item.id === saved.id ? saved : item).sort(compareWatchlists));
      setEditor(undefined);
      navigate(watchlistsPath([saved.id]));
    } catch (requestError) {
      setError(message(requestError));
    }
  };

  const removeSelected = async () => {
    if (deleteTarget === undefined) return;
    try {
      await deleteWatchlist(deleteTarget.id);
      const remaining = watchlists.filter((item) => item.id !== deleteTarget.id);
      setWatchlists(remaining);
      setDeleteTarget(undefined);
      navigate(watchlistsPath([remaining[0]!.id]), { replace: true });
    } catch (requestError) {
      setError(message(requestError));
    }
  };

  const download = async () => {
    if (!selectionReady || symbols.length === 0) return;
    setDownloading(true);
    try {
      const rows: string[][] = [];
      for (const symbol of symbols) {
        const ticker = await fetchThemeTicker(symbol);
        rows.push([
          symbol,
          ticker.name ?? "",
          ticker.industries.map((industry) => industry.name).join("; "),
        ]);
      }
      const csv = [
        "symbol,name,industries",
        ...rows.map((row) => row.map(csvCell).join(",")),
      ].join("\n");
      const date = await fetchNextTradingDay();
      const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `${date}-${soleSelected === undefined ? "merged-watchlists" : slug(soleSelected.name)}.csv`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (requestError) {
      setError(message(requestError));
    } finally {
      setDownloading(false);
    }
  };

  const addTicker = async () => {
    const watchlistId = soleSelected?.id;
    if (watchlistId === undefined || addingTicker) return;
    const requestSelectionKey = selectionKey;
    const symbol = tickerInput.trim().toUpperCase();
    if (symbol === "") return;
    setAddingTicker(true);
    try {
      await addTickerToWatchlist(watchlistId, symbol);
      if (selectionKeyRef.current === requestSelectionKey) {
        setSymbols((current) => current.includes(symbol) ? current : [...current, symbol].sort());
      }
      setTickerInput("");
    } catch (requestError) {
      setError(message(requestError));
    } finally {
      setAddingTicker(false);
    }
  };

  const selectOnly = (watchlistId: number) => {
    navigate(watchlistsPath([watchlistId]));
  };

  const toggleMergedSelection = (watchlistId: number) => {
    const selected = selectedIdSet.has(watchlistId);
    if (selected && selectedIds.length === 1) return;
    navigate(watchlistsPath(
      selected
        ? selectedIds.filter((itemId) => itemId !== watchlistId)
        : [...selectedIds, watchlistId],
    ));
  };

  return (
    <section className="workspace-panel watchlists-page" aria-label="Watchlists">
      <header className="panel-header watchlists-header">
        <Typography component="h1">Watchlists</Typography>
        {selectionReady && (
          <Select
            multiple
            size="small"
            value={selectedIds}
            aria-label="Selected watchlists"
            onChange={() => undefined}
            renderValue={() => soleSelected === undefined
              ? `${selectedWatchlists.length} watchlists`
              : (
                <>
                  <WatchlistIcon iconKey={soleSelected.icon_key} fontSize="inherit" />
                  {soleSelected.name}
                </>
              )}
          >
            {watchlists.map((watchlist) => (
              <MenuItem
                className="watchlist-select-option"
                key={watchlist.id}
                value={watchlist.id}
                onClick={() => selectOnly(watchlist.id)}
              >
                <WatchlistIcon iconKey={watchlist.icon_key} fontSize="inherit" />
                {watchlist.name}
                <Checkbox
                  className="watchlist-select-checkbox"
                  size="small"
                  checked={selectedIdSet.has(watchlist.id)}
                  disabled={selectedIds.length === 1 && selectedIdSet.has(watchlist.id)}
                  slotProps={{ input: { "aria-label": `Include ${watchlist.name} in merged view` } }}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    toggleMergedSelection(watchlist.id);
                  }}
                />
              </MenuItem>
            ))}
          </Select>
        )}
        <Typography className="watchlists-count" color="text.secondary">
          {!selectionReady
            ? ""
            : `${symbols.length}${selectedWatchlists.length > 1 ? " unique" : ""} tickers`}
        </Typography>
        {selectionReady && (
          <div className="watchlists-ticker-strength">
            <Divider orientation="vertical" flexItem />
            <TickerStrengthControls />
          </div>
        )}
        <TextField
          className="watchlists-add-ticker"
          size="small"
          value={tickerInput}
          disabled={soleSelected === undefined || addingTicker}
          placeholder="Add ticker"
          slotProps={{
            htmlInput: { "aria-label": "Add ticker", maxLength: 12 },
            input: {
              endAdornment: (
                <InputAdornment position="end">
                  <IconButton
                    edge="end"
                    size="small"
                    aria-label="Submit ticker"
                    disabled={soleSelected === undefined || addingTicker || tickerInput.trim() === ""}
                    onClick={() => void addTicker()}
                  >
                    <ArrowForwardIcon fontSize="small" />
                  </IconButton>
                </InputAdornment>
              ),
            },
          }}
          onChange={(event) => setTickerInput(event.target.value.toUpperCase())}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            void addTicker();
          }}
        />
        <div className="watchlists-actions">
          {(loading || symbolsLoading || downloading || addingTicker) && <CircularProgress size="0.8rem" />}
          <Tooltip title="Create watchlist"><span><IconButton size="small" disabled={watchlists.length >= watchlistIcons.length} onClick={() => setEditor(null)}><AddIcon fontSize="small" /></IconButton></span></Tooltip>
          <Tooltip title="Edit watchlist"><span><IconButton size="small" disabled={soleSelected === undefined || soleSelected.is_default} onClick={() => setEditor(soleSelected)}><EditOutlinedIcon fontSize="small" /></IconButton></span></Tooltip>
          <Tooltip title="Delete watchlist"><span><IconButton size="small" disabled={soleSelected === undefined || soleSelected.is_default} onClick={() => setDeleteTarget(soleSelected)}><DeleteOutlinedIcon fontSize="small" /></IconButton></span></Tooltip>
          <Tooltip title="Export watchlist CSV"><span><IconButton size="small" disabled={!selectionReady || symbols.length === 0 || downloading} onClick={() => void download()}><FileDownloadIcon fontSize="small" /></IconButton></span></Tooltip>
        </div>
      </header>
      {!selectionReady || symbolsSelectionKey !== selectionKey ? (
        <div className="panel-status">{loading || symbolsLoading ? <CircularProgress size="1rem" /> : null}</div>
      ) : symbols.length === 0 ? (
        <div className="panel-status"><Typography color="text.secondary">{soleSelected === undefined ? "No tickers in selected watchlists" : `No tickers in ${soleSelected.name}`}</Typography></div>
      ) : (
        <TickerLens
          key={selectionKey}
          accent="yellow"
          universe={{ type: "bounded", symbols }}
          metricExtensions={tickerStrength.metricExtensions}
          watchlists={watchlists}
          onWatchlistsChange={(symbol, watchlistIds) => {
            if (!watchlistIds.some((watchlistId) => selectedIdSet.has(watchlistId))) {
              setSymbols((current) => current.filter((item) => item !== symbol));
            }
          }}
        />
      )}
      {editor !== undefined && <WatchlistEditor watchlist={editor} watchlists={watchlists} onClose={() => setEditor(undefined)} onSave={saveWatchlist} />}
      <Dialog open={deleteTarget !== undefined} onClose={() => setDeleteTarget(undefined)}>
        <DialogTitle>Delete watchlist?</DialogTitle>
        <DialogContent><Typography>This removes {deleteTarget?.name} and all of its ticker memberships.</Typography></DialogContent>
        <DialogActions><Button onClick={() => setDeleteTarget(undefined)}>Cancel</Button><Button color="error" onClick={() => void removeSelected()}>Delete</Button></DialogActions>
      </Dialog>
      <Toast message={error} onClose={() => setError(undefined)} />
    </section>
  );
}

function WatchlistEditor({ watchlist, watchlists, onClose, onSave }: { watchlist: Watchlist | null; watchlists: Watchlist[]; onClose: () => void; onSave: (name: string, iconKey: string) => Promise<void> }) {
  const usedIconKeys = useMemo(
    () => new Set(watchlists.filter((item) => item.id !== watchlist?.id).map((item) => item.icon_key)),
    [watchlist, watchlists],
  );
  const firstAvailableIcon = watchlistIcons.find((icon) => !usedIconKeys.has(icon.key));
  const [name, setName] = useState(watchlist?.name ?? "");
  const [iconKey, setIconKey] = useState(watchlist?.icon_key ?? firstAvailableIcon?.key ?? "");
  return (
    <Dialog open onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>{watchlist === null ? "Create watchlist" : "Edit watchlist"}</DialogTitle>
      <DialogContent className="watchlist-editor">
        <TextField autoFocus fullWidth size="small" label="Name" value={name} slotProps={{ htmlInput: { maxLength: 40 } }} onChange={(event) => setName(event.target.value)} />
        <div className="watchlist-icon-grid">
          {watchlistIcons.map(({ key, label, Icon }) => <Tooltip title={usedIconKeys.has(key) ? `${label} · already used` : label} key={key}><span><IconButton disabled={usedIconKeys.has(key)} className={iconKey === key ? "watchlist-icon-selected" : undefined} onClick={() => setIconKey(key)}><Icon /></IconButton></span></Tooltip>)}
        </div>
      </DialogContent>
      <DialogActions><Button onClick={onClose}>Cancel</Button><Button disabled={name.trim() === "" || iconKey === ""} onClick={() => void onSave(name, iconKey)}>Save</Button></DialogActions>
    </Dialog>
  );
}

function compareWatchlists(left: Watchlist, right: Watchlist) {
  if (left.is_default !== right.is_default) return left.is_default ? -1 : 1;
  return left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
}
function csvCell(value: string) { return `"${value.replaceAll('"', '""')}"`; }
function slug(value: string) { return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "watchlist"; }
function message(error: unknown) { return error instanceof Error ? error.message : "Watchlist request failed"; }
function parseSelectedWatchlistIds(value: string | null | undefined) {
  if (value === null || value === undefined) return [];
  return [...new Set(
    value
      .split(",")
      .map(Number)
      .filter((id) => Number.isInteger(id) && id > 0),
  )].sort((left, right) => left - right);
}
function serializeWatchlistIds(ids: number[]) { return [...ids].sort((left, right) => left - right).join(","); }
function watchlistsPath(ids: number[]) { return `/watchlists/${serializeWatchlistIds(ids)}`; }
function readSelectedWatchlistIds() { return parseSelectedWatchlistIds(localStorage.getItem(selectedWatchlistStorageKey)); }
