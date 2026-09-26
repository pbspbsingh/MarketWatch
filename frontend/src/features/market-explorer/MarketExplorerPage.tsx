import { lazy, Suspense, useEffect, useState } from "react";
import {
  Button,
  CircularProgress,
  LinearProgress,
  MenuItem,
  Select,
  Typography,
  type SelectChangeEvent,
} from "@mui/material";
import {
  fetchMarketExplorerCandleStatus,
  pauseMarketExplorerCandleFetch,
  retryFailedMarketExplorerCandleFetch,
  startMarketExplorerCandleFetch,
  type MarketExplorerCandleStatus,
} from "../../api/marketExplorer";
import { Toast } from "../../components/Toast";
import "./market-explorer.css";

const HighestVolumeTab = lazy(() =>
  import("./highest-volume/HighestVolumeTab").then(({ HighestVolumeTab }) => ({
    default: HighestVolumeTab,
  })),
);

const HighestReturnTab = lazy(() =>
  import("./highest-return/HighestReturnTab").then(({ HighestReturnTab }) => ({
    default: HighestReturnTab,
  })),
);

const HighRsTab = lazy(() =>
  import("./high-rs/HighRsTab").then(({ HighRsTab }) => ({
    default: HighRsTab,
  })),
);

const PowerPlayTab = lazy(() =>
  import("./power-play/PowerPlayTab").then(({ PowerPlayTab }) => ({
    default: PowerPlayTab,
  })),
);

type MarketExplorerView = "market-explorer" | "highest-volume" | "highest-return" | "high-rs" | "power-play";

export function MarketExplorerPage() {
  const [status, setStatus] = useState<MarketExplorerCandleStatus>();
  const [loading, setLoading] = useState(true);
  const [actionPending, setActionPending] = useState(false);
  const [error, setError] = useState<string>();
  const [activeView, setActiveView] = useState<MarketExplorerView>("market-explorer");
  const [toolbarContainer, setToolbarContainer] = useState<HTMLDivElement | null>(null);

  useEffect(() => {
    if (activeView !== "market-explorer") return;

    let active = true;
    const controller = new AbortController();
    let firstRequest = true;
    const refresh = () => fetchMarketExplorerCandleStatus(controller.signal, firstRequest)
      .then((next) => {
        firstRequest = false;
        if (active) setStatus(next);
      })
      .catch((requestError: unknown) => {
        if (active && requestError instanceof Error && requestError.name !== "AbortError") {
          setError(requestError.message);
        }
      });
    void refresh().finally(() => {
      if (active) setLoading(false);
    });
    const interval = window.setInterval(() => void refresh(), 1_000);
    return () => {
      active = false;
      controller.abort();
      window.clearInterval(interval);
    };
  }, [activeView]);

  const runAction = async (action: () => Promise<MarketExplorerCandleStatus>) => {
    setActionPending(true);
    setError(undefined);
    try {
      setStatus(await action());
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Market Explorer request failed");
    } finally {
      setActionPending(false);
    }
  };

  const viewsEnabled = status !== undefined && (
    status.requires_fetch === 0
    || (status.phase === "completed" && status.processed === status.fetch_total)
  );

  return (
    <section className="workspace-panel market-explorer-page" aria-label="Market Explorer">
      <header className="panel-header market-explorer-header">
        <Select
          className="market-explorer-view-select"
          variant="standard"
          value={activeView}
          inputProps={{ "aria-label": "Market Explorer view" }}
          onChange={(event: SelectChangeEvent<MarketExplorerView>) => {
            setActiveView(event.target.value as MarketExplorerView);
          }}
        >
          <MenuItem value="market-explorer">Market Explorer</MenuItem>
          <MenuItem value="highest-volume" disabled={!viewsEnabled}>Highest Volume</MenuItem>
          <MenuItem value="highest-return" disabled={!viewsEnabled}>Highest Return</MenuItem>
          <MenuItem value="high-rs" disabled={!viewsEnabled}>Highest RS</MenuItem>
          <MenuItem value="power-play" disabled={!viewsEnabled}>Power Play</MenuItem>
        </Select>
        <div className="market-explorer-toolbar-slot" ref={setToolbarContainer} />
      </header>
      {viewsEnabled && activeView === "highest-volume" ? (
        <Suspense fallback={<div className="panel-status"><CircularProgress size="1rem" /></div>}>
          <HighestVolumeTab toolbarContainer={toolbarContainer} />
        </Suspense>
      ) : viewsEnabled && activeView === "highest-return" ? (
        <Suspense fallback={<div className="panel-status"><CircularProgress size="1rem" /></div>}>
          <HighestReturnTab toolbarContainer={toolbarContainer} />
        </Suspense>
      ) : viewsEnabled && activeView === "high-rs" && status !== undefined ? (
        <Suspense fallback={<div className="panel-status"><CircularProgress size="1rem" /></div>}>
          <HighRsTab toolbarContainer={toolbarContainer} asOf={status.target_date} />
        </Suspense>
      ) : viewsEnabled && activeView === "power-play" ? (
        <Suspense fallback={<div className="panel-status"><CircularProgress size="1rem" /></div>}>
          <PowerPlayTab toolbarContainer={toolbarContainer} />
        </Suspense>
      ) : loading && status === undefined ? (
        <div className="panel-status">
          <CircularProgress size="1rem" />
          <Typography color="text.secondary">Checking industry ticker candles</Typography>
        </div>
      ) : status !== undefined ? (
        <div className="market-explorer-landing">
          <div className="market-explorer-landing-content">
            <section className="market-explorer-candle-card" aria-labelledby="market-explorer-candle-title">
              <div className="market-explorer-candle-heading">
                <div>
                  <Typography id="market-explorer-candle-title" component="h2">
                    Daily candle readiness
                  </Typography>
                  <Typography color="text.secondary">
                    Latest completed trading day: {status.target_date}
                  </Typography>
                </div>
                <Button
                  variant="contained"
                  size="small"
                  disabled={actionPending
                    || status.phase === "completed"
                    || (status.requires_fetch === 0 && status.phase !== "running")}
                  onClick={() => void runAction(
                    status.phase === "running"
                      ? pauseMarketExplorerCandleFetch
                      : startMarketExplorerCandleFetch,
                  )}
                >
                  {fetchButtonLabel(status, actionPending)}
                </Button>
              </div>

              <dl className="market-explorer-summary">
                <Summary label="Industry-mapped tickers" value={status.industry_mapped_tickers} />
                <Summary label="Total tickers in system" value={status.total_tickers} />
                <Summary label="Tickers with latest candle" value={status.latest_candle_tickers} />
                <Summary label="Tickers requiring candle fetch" value={status.requires_fetch} />
              </dl>

              <div className="market-explorer-progress-row">
                <LinearProgress
                  className="market-explorer-progress"
                  variant="determinate"
                  value={progressPercent(status)}
                  aria-label="Daily candle fetch progress"
                />
                <Typography className="market-explorer-timer" component="span">
                  {formatElapsed(status.elapsed_seconds)}
                </Typography>
              </div>
              <Typography className="market-explorer-progress-caption" color="text.secondary">
                {status.processed}/{status.fetch_total} processed
                {status.current_symbol === null ? "" : ` · Fetching ${status.current_symbol}`}
                {status.failed === 0 ? "" : ` · ${status.failed} failed`}
              </Typography>

              {status.messages.length > 0 && (
                <section className="market-explorer-messages" aria-label="Candle fetch failures">
                  <div className="market-explorer-messages-heading">
                    <Typography component="h3">Progress messages</Typography>
                    <Button
                      size="small"
                      variant="outlined"
                      disabled={actionPending || status.phase !== "completed"}
                      onClick={() => void runAction(retryFailedMarketExplorerCandleFetch)}
                    >
                      Retry failed tickers
                    </Button>
                  </div>
                  <div role="log" aria-live="polite">
                    {status.messages.map((message, index) => (
                      <Typography key={`${message.symbol}:${index}`} component="p">
                        <strong>{message.symbol}</strong> failed: {message.error}
                      </Typography>
                    ))}
                  </div>
                </section>
              )}
            </section>
            <section className="market-explorer-view-list" aria-labelledby="market-explorer-views-title">
              <Typography id="market-explorer-views-title" component="h2">
                Explorer tabs
              </Typography>
              <div className="market-explorer-view-buttons">
                <Button
                  variant="outlined"
                  disabled={!viewsEnabled}
                  onClick={() => setActiveView("highest-volume")}
                >
                  Highest Volume
                </Button>
                <Button
                  variant="outlined"
                  disabled={!viewsEnabled}
                  onClick={() => setActiveView("highest-return")}
                >
                  Highest Return
                </Button>
                <Button
                  variant="outlined"
                  disabled={!viewsEnabled}
                  onClick={() => setActiveView("high-rs")}
                >
                  Highest RS
                </Button>
                <Button
                  variant="outlined"
                  disabled={!viewsEnabled}
                  onClick={() => setActiveView("power-play")}
                >
                  Power Play
                </Button>
              </div>
            </section>
          </div>
        </div>
      ) : null}
      <Toast message={error} onClose={() => setError(undefined)} />
    </section>
  );
}

function Summary({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value.toLocaleString()}</dd>
    </div>
  );
}

function progressPercent(status: MarketExplorerCandleStatus) {
  return status.fetch_total === 0 ? 100 : Math.min(100, 100 * status.processed / status.fetch_total);
}

function fetchButtonLabel(status: MarketExplorerCandleStatus, actionPending: boolean) {
  if (actionPending) return "Working…";
  if (status.phase === "running") return "Pause fetching";
  if (status.phase === "paused") return "Resume fetching";
  if (status.requires_fetch === 0) return "Up to date";
  if (status.phase === "completed") return "Fetching completed";
  return "Start fetching";
}

function formatElapsed(seconds: number) {
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainder = seconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
    : `${minutes}:${String(remainder).padStart(2, "0")}`;
}
