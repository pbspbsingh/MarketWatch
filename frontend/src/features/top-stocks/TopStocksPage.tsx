import { useEffect, useState } from "react";
import RefreshIcon from "@mui/icons-material/Refresh";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutlined";
import {
  Checkbox,
  CircularProgress,
  FormControlLabel,
  IconButton,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import {
  clearTopStocks,
  fetchTopStocks,
  refreshTopStocks,
  replaceTopStocks,
  type TopStocksPeriod,
  type TopStocksSelection,
  type TopStocksSnapshot,
} from "../../api/topStocks";
import { Toast } from "../../components/Toast";
import { TickerLens } from "../ticker-lens/TickerLens";
import "./top-stocks.css";

const periods: { period: TopStocksPeriod; label: string }[] = [
  { period: "week1", label: "1 Week" },
  { period: "month1", label: "1 Month" },
  { period: "months3", label: "3 Months" },
  { period: "months6", label: "6 Months" },
  { period: "year1", label: "1 Year" },
];
const defaultCount = 100;

export function TopStocksPage() {
  const [snapshot, setSnapshot] = useState<TopStocksSnapshot | null>();
  const [draftCounts, setDraftCounts] = useState<Record<TopStocksPeriod, string>>(() =>
    Object.fromEntries(periods.map(({ period }) => [period, String(defaultCount)])) as Record<
      TopStocksPeriod,
      string
    >,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  useEffect(() => {
    const controller = new AbortController();
    fetchTopStocks(controller.signal)
      .then((nextSnapshot) => {
        if (controller.signal.aborted) return;
        setSnapshot(nextSnapshot);
        if (nextSnapshot !== null) {
          setDraftCounts((counts) => ({
            ...counts,
            ...Object.fromEntries(
              nextSnapshot.selections.map(({ period, count }) => [period, String(count)]),
            ),
          }));
        }
      })
      .catch((requestError: unknown) => {
        if (!controller.signal.aborted) {
          setSnapshot(null);
          setError(message(requestError));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, []);

  const selections = snapshot?.selections ?? [];
  const selected = (period: TopStocksPeriod) =>
    selections.some((selection) => selection.period === period);
  const save = async (nextSelections: TopStocksSelection[]) => {
    setLoading(true);
    setError(undefined);
    try {
      setSnapshot(await replaceTopStocks(nextSelections));
    } catch (requestError) {
      setError(message(requestError));
    } finally {
      setLoading(false);
    }
  };
  const countFor = (period: TopStocksPeriod) => {
    const value = Number(draftCounts[period]);
    return Number.isInteger(value) && value > 0 ? value : defaultCount;
  };

  return (
    <section className="workspace-panel top-stocks-page" aria-label="Top Stocks">
      <header className="panel-header top-stocks-header">
        <Typography component="h1">Top Stocks</Typography>
        <div className="top-stocks-actions">
          <div className="top-stocks-controls">
            {periods.map(({ period, label }) => (
              <div className="top-stocks-period" key={period}>
              <FormControlLabel
                control={
                  <Checkbox
                    size="small"
                    checked={selected(period)}
                    disabled={loading}
                    onChange={(event) => {
                      const next = event.target.checked
                        ? [...selections, { period, count: countFor(period) }]
                        : selections.filter((selection) => selection.period !== period);
                      void save(next);
                    }}
                  />
                }
                label={label}
              />
              <TextField
                size="small"
                type="number"
                value={draftCounts[period]}
                disabled={loading}
                slotProps={{
                  htmlInput: { min: 1, max: 1000, "aria-label": `${label} count` },
                }}
                onChange={(event) =>
                  setDraftCounts((counts) => ({ ...counts, [period]: event.target.value }))
                }
                onBlur={() => {
                  if (!selected(period)) return;
                  const count = countFor(period);
                  setDraftCounts((counts) => ({ ...counts, [period]: String(count) }));
                  if (selections.find((selection) => selection.period === period)?.count !== count) {
                    void save(
                      selections.map((selection) =>
                        selection.period === period ? { ...selection, count } : selection,
                      ),
                    );
                  }
                }}
              />
              </div>
            ))}
            {loading && <CircularProgress size="0.8rem" />}
            <div className="top-stocks-action-buttons">
              <Tooltip title="Refresh top stocks">
                <span>
                  <IconButton
                    size="small"
                    disabled={loading || snapshot === null}
                    onClick={() => {
                      setLoading(true);
                      void refreshTopStocks()
                        .then(setSnapshot)
                        .catch((requestError: unknown) => setError(message(requestError)))
                        .finally(() => setLoading(false));
                    }}
                  >
                    <RefreshIcon fontSize="small" />
                  </IconButton>
                </span>
              </Tooltip>
              <Tooltip title="Clear top stocks">
                <span>
                  <IconButton
                    size="small"
                    disabled={loading || snapshot === null}
                    onClick={() => {
                      setLoading(true);
                      void clearTopStocks()
                        .then(() => setSnapshot(null))
                        .catch((requestError: unknown) => setError(message(requestError)))
                        .finally(() => setLoading(false));
                    }}
                  >
                    <DeleteOutlineIcon fontSize="small" />
                  </IconButton>
                </span>
              </Tooltip>
            </div>
          </div>
        </div>
      </header>
      {snapshot === undefined ? (
        <div className="panel-status"><CircularProgress size="1rem" /></div>
      ) : snapshot === null || snapshot.symbols.length === 0 ? (
        <div className="panel-status"><Typography color="text.secondary">Select a period to load top stocks</Typography></div>
      ) : (
        <TickerLens accent="green" universe={{ type: "bounded", symbols: snapshot.symbols }} />
      )}
      <Toast message={error} onClose={() => setError(undefined)} />
    </section>
  );
}

function message(error: unknown) {
  return error instanceof Error ? error.message : "Top stocks request failed";
}
