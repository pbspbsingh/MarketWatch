import { useEffect, useMemo, useState } from "react";
import AddIcon from "@mui/icons-material/Add";
import DeleteOutlinedIcon from "@mui/icons-material/DeleteOutlined";
import EditOutlinedIcon from "@mui/icons-material/EditOutlined";
import FileDownloadIcon from "@mui/icons-material/FileDownload";
import {
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
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
import { WatchlistIcon, watchlistIcons } from "./WatchlistIcon";
import "./watchlists.css";

const selectedWatchlistStorageKey = "market-watch.selected-watchlist";

export function WatchlistsPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const focusRevision = useFocusRefresh();
  const [watchlists, setWatchlists] = useState<Watchlist[]>([]);
  const [symbols, setSymbols] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [symbolsLoading, setSymbolsLoading] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [editor, setEditor] = useState<Watchlist | null | undefined>();
  const [deleteTarget, setDeleteTarget] = useState<Watchlist>();
  const [error, setError] = useState<string>();
  const selectedId = Number(id);
  const selected = watchlists.find((watchlist) => watchlist.id === selectedId);

  useEffect(() => {
    const controller = new AbortController();
    fetchWatchlists(controller.signal)
      .then((items) => {
        if (controller.signal.aborted) return;
        setWatchlists(items);
        const requested = items.find((item) => item.id === selectedId);
        if (requested === undefined && items[0] !== undefined) {
          const storedId = id === undefined ? readSelectedWatchlistId() : undefined;
          const fallback = items.find((item) => item.id === storedId) ?? items[0];
          navigate(`/watchlists/${fallback.id}`, { replace: true });
        }
      })
      .catch((requestError: unknown) => {
        if (!controller.signal.aborted) setError(message(requestError));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [focusRevision, id, navigate, selectedId]);

  useEffect(() => {
    if (selected !== undefined) {
      localStorage.setItem(selectedWatchlistStorageKey, String(selected.id));
    }
  }, [selected?.id]);

  useEffect(() => {
    if (selected === undefined) return;
    const controller = new AbortController();
    setSymbolsLoading(true);
    fetchWatchlistSymbols(selected.id, controller.signal)
      .then((items) => {
        if (!controller.signal.aborted) setSymbols(items);
      })
      .catch((requestError: unknown) => {
        if (!controller.signal.aborted) setError(message(requestError));
      })
      .finally(() => {
        if (!controller.signal.aborted) setSymbolsLoading(false);
      });
    return () => controller.abort();
  }, [focusRevision, selected?.id]);

  const saveWatchlist = async (name: string, iconKey: string) => {
    try {
      const saved = editor === null
        ? await createWatchlist({ name, icon_key: iconKey })
        : await updateWatchlist(editor!.id, { name, icon_key: iconKey });
      setWatchlists((current) => editor === null
        ? [...current, saved].sort(compareWatchlists)
        : current.map((item) => item.id === saved.id ? saved : item).sort(compareWatchlists));
      setEditor(undefined);
      navigate(`/watchlists/${saved.id}`);
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
      navigate(`/watchlists/${remaining[0]!.id}`, { replace: true });
    } catch (requestError) {
      setError(message(requestError));
    }
  };

  const download = async () => {
    if (selected === undefined || symbols.length === 0) return;
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
      link.download = `${date}-${slug(selected.name)}.csv`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (requestError) {
      setError(message(requestError));
    } finally {
      setDownloading(false);
    }
  };

  return (
    <section className="workspace-panel watchlists-page" aria-label="Watchlists">
      <header className="panel-header watchlists-header">
        <Typography component="h1">Watchlists</Typography>
        {selected !== undefined && (
          <Select
            size="small"
            value={selected.id}
            aria-label="Selected watchlist"
            onChange={(event) => navigate(`/watchlists/${event.target.value}`)}
          >
            {watchlists.map((watchlist) => (
              <MenuItem className="watchlist-select-option" key={watchlist.id} value={watchlist.id}>
                <WatchlistIcon iconKey={watchlist.icon_key} fontSize="inherit" />
                {watchlist.name}
              </MenuItem>
            ))}
          </Select>
        )}
        <Typography className="watchlists-count" color="text.secondary">
          {selected === undefined ? "" : `${symbols.length} tickers`}
        </Typography>
        <div className="watchlists-actions">
          {(loading || symbolsLoading || downloading) && <CircularProgress size="0.8rem" />}
          <Tooltip title="Create watchlist"><span><IconButton size="small" disabled={watchlists.length >= watchlistIcons.length} onClick={() => setEditor(null)}><AddIcon fontSize="small" /></IconButton></span></Tooltip>
          <Tooltip title="Edit watchlist"><span><IconButton size="small" disabled={selected === undefined || selected.is_default} onClick={() => setEditor(selected)}><EditOutlinedIcon fontSize="small" /></IconButton></span></Tooltip>
          <Tooltip title="Delete watchlist"><span><IconButton size="small" disabled={selected === undefined || selected.is_default} onClick={() => setDeleteTarget(selected)}><DeleteOutlinedIcon fontSize="small" /></IconButton></span></Tooltip>
          <Tooltip title="Export watchlist CSV"><span><IconButton size="small" disabled={selected === undefined || symbols.length === 0 || downloading} onClick={() => void download()}><FileDownloadIcon fontSize="small" /></IconButton></span></Tooltip>
        </div>
      </header>
      {selected === undefined || symbolsLoading ? (
        <div className="panel-status">{loading || symbolsLoading ? <CircularProgress size="1rem" /> : null}</div>
      ) : symbols.length === 0 ? (
        <div className="panel-status"><Typography color="text.secondary">No tickers in {selected.name}</Typography></div>
      ) : (
        <TickerLens
          key={selected.id}
          accent="yellow"
          universe={{ type: "bounded", symbols }}
          watchlists={watchlists}
          onWatchlistsChange={(symbol, watchlistIds) => {
            if (!watchlistIds.includes(selected.id)) setSymbols((current) => current.filter((item) => item !== symbol));
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
function readSelectedWatchlistId() {
  const value = Number(localStorage.getItem(selectedWatchlistStorageKey));
  return Number.isInteger(value) && value > 0 ? value : undefined;
}
