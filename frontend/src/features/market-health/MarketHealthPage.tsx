import { useEffect, useMemo, useRef, useState } from "react";
import UploadFileOutlinedIcon from "@mui/icons-material/UploadFileOutlined";
import {
  Button,
  CircularProgress,
  IconButton,
  Tab as MuiTab,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TableSortLabel,
  Tabs,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from "@mui/material";
import {
  changeMarketHealthLifecycle,
  fetchMarketHealthTab,
  fetchMarketHealthUniverse,
  restartMarketHealth,
  uploadMarketHealthUniverse,
  type MarketHealthJobSnapshot,
  type MarketHealthProgressStep,
  type MarketHealthTabResponse,
  type MarketHealthUniverse,
} from "../../api/marketHealth";
import { MarketHealthChart } from "./MarketHealthChart";
import {
  industryMarketWatchUrl,
  industriesMarketWatchUrl,
  tickerMarketWatchUrl,
} from "../ticker-lens/utils";
import "./market-health.css";

const tabs = [
  ["overview", "Overview"],
  ["trend_breadth", "Trend Breadth"],
  ["highs_breadth", "Highs & Breadth"],
  ["leadership", "Leadership"],
  ["market_structure", "Market Structure"],
  ["leader_lists", "Leader Lists"],
] as const;

type Tab = (typeof tabs)[number][0];
type Rs = "1m" | "3m" | "6m";

export function MarketHealthPage() {
  const [universe, setUniverse] = useState<MarketHealthUniverse | null>(null);
  const [snapshot, setSnapshot] = useState<MarketHealthJobSnapshot>({
    revision: 0,
    phase: "no_universe",
  });
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string>();
  const [tab, setTab] = useState<Tab>("overview");
  const [rs, setRs] = useState<Rs>("3m");
  const [threshold, setThreshold] = useState(80);
  const [latestSession, setLatestSession] = useState<string>();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetchMarketHealthUniverse(controller.signal)
      .then(setUniverse)
      .catch((requestError: unknown) => {
        if (!(requestError instanceof Error && requestError.name === "AbortError")) {
          setError(errorMessage(requestError, "Unable to load universe"));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, []);

  useProgressSocket(setSnapshot);

  const leadershipSensitive = tab === "overview"
    || tab === "leadership"
    || tab === "leader_lists";
  const calculationRs: Rs = leadershipSensitive ? rs : "3m";
  const calculationThreshold = leadershipSensitive ? threshold : 80;

  const upload = async (file: File) => {
    setUploading(true);
    setError(undefined);
    setLatestSession(undefined);
    try {
      setUniverse(await uploadMarketHealthUniverse(file));
    } catch (requestError) {
      setError(errorMessage(requestError, "Upload failed"));
    } finally {
      setUploading(false);
    }
  };

  const lifecycle = async (action: "pause" | "resume") => {
    setError(undefined);
    try {
      setSnapshot(await changeMarketHealthLifecycle(action));
    } catch (requestError) {
      setError(errorMessage(requestError, `Unable to ${action}`));
    }
  };

  const restart = async (action: "refresh" | "retry") => {
    setError(undefined);
    setLatestSession(undefined);
    try {
      setSnapshot(await restartMarketHealth(action));
    } catch (requestError) {
      setError(errorMessage(requestError, `Unable to ${action}`));
    }
  };

  const progress = snapshot.progress;
  const usableCount = universe === null
    ? 0
    : progress?.total_tickers ?? universe.usable_count;

  return (
    <section
      className="workspace-panel market-health-page"
      aria-label="Market Health"
      data-testid="market-health-page"
    >
      <header
        className="panel-header market-health-header"
        data-testid="market-health-header"
      >
        <Typography component="h1">Market Health</Typography>
        <Typography className="market-health-universe" color="text.secondary">
          {universe === null ? (
            "No universe loaded"
          ) : (
            <>Universe: <strong>{universe.file_name}</strong> · {usableCount}/{universe.imported_count} Tickers</>
          )}
        </Typography>
        {snapshot.phase === "ready" && latestSession !== undefined && (
          <Typography className="market-health-through" color="text.secondary">
            Through {latestSession}
          </Typography>
        )}
        {snapshot.phase === "ready" && (
          <ReadyControls
            rs={rs}
            threshold={threshold}
            tab={tab}
            setRs={setRs}
            setThreshold={setThreshold}
            setTab={setTab}
          />
        )}
        {snapshot.phase === "stale" && (
          <Button size="small" onClick={() => void restart("refresh")}>Refresh</Button>
        )}
        <input
          ref={inputRef}
          hidden
          accept=".csv,text/csv"
          type="file"
          data-testid="market-health-file-input"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file !== undefined) void upload(file);
            event.target.value = "";
          }}
        />
        <Tooltip title="Upload CSV">
          <span className="market-health-upload-wrapper">
            <IconButton
              disabled={uploading}
              size="small"
              aria-label="Upload CSV"
              data-testid="market-health-upload"
              onClick={() => inputRef.current?.click()}
            >
              <UploadFileOutlinedIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
      </header>
      {snapshot.phase === "ready" ? (
        <ReadyContent
          key={`${snapshot.job_id}-${tab}`}
          tab={tab}
          rs={calculationRs}
          threshold={calculationThreshold}
          pageError={error}
          onLatestSession={setLatestSession}
        />
      ) : (
        <Progress
          universe={universe}
          loading={loading}
          error={error}
          phase={snapshot.phase}
          progress={progress}
          onLifecycle={lifecycle}
          onRetry={() => restart("retry")}
        />
      )}
    </section>
  );
}

function useProgressSocket(
  onSnapshot: (snapshot: MarketHealthJobSnapshot) => void,
) {
  useEffect(() => {
    let socket: WebSocket | undefined;
    let reconnect: number | undefined;
    let stopped = false;

    const connect = () => {
      const protocol = location.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(`${protocol}//${location.host}/api/market-health/progress`);
      socket.addEventListener("message", (event) => {
        onSnapshot(JSON.parse(String(event.data)) as MarketHealthJobSnapshot);
      });
      socket.addEventListener("close", () => {
        if (!stopped) reconnect = window.setTimeout(connect, 1_000);
      });
    };

    connect();
    return () => {
      stopped = true;
      if (reconnect !== undefined) window.clearTimeout(reconnect);
      socket?.close();
    };
  }, [onSnapshot]);
}

interface ReadyControlsProps {
  rs: Rs;
  threshold: number;
  tab: Tab;
  setRs: (value: Rs) => void;
  setThreshold: (value: number) => void;
  setTab: (value: Tab) => void;
}

function ReadyControls(props: ReadyControlsProps) {
  return (
    <div className="market-health-ready-controls">
      <Tabs
        className="market-health-tabs"
        value={props.tab}
        variant="scrollable"
        scrollButtons={false}
        aria-label="Market Health views"
        onChange={(_, value: Tab) => props.setTab(value)}
      >
        {tabs.map(([value, label]) => (
          <MuiTab
            key={value}
            value={value}
            label={label}
          />
        ))}
      </Tabs>
      <ToggleButtonGroup
        size="small"
        exclusive
        value={props.rs}
        onChange={(_, value: Rs | null) => value !== null && props.setRs(value)}
      >
        <ToggleButton value="1m">1M</ToggleButton>
        <ToggleButton value="3m">3M</ToggleButton>
        <ToggleButton value="6m">6M</ToggleButton>
      </ToggleButtonGroup>
      <label className="market-health-leader-control">
        <span>Leader RS</span>
        <TextField
          size="small"
          type="number"
          value={props.threshold}
          slotProps={{ htmlInput: { min: 0, max: 100, step: 1 } }}
          onChange={(event) => {
            const value = Number(event.target.value);
            if (Number.isInteger(value) && value >= 0 && value <= 100) {
              props.setThreshold(value);
            }
          }}
        />
      </label>
    </div>
  );
}

interface ProgressProps {
  universe: MarketHealthUniverse | null;
  loading: boolean;
  error?: string;
  phase: MarketHealthJobSnapshot["phase"];
  progress?: MarketHealthJobSnapshot["progress"];
  onLifecycle: (action: "pause" | "resume") => Promise<void>;
  onRetry: () => Promise<void>;
}

function Progress(props: ProgressProps) {
  const total = props.progress?.total_work_items ?? 0;
  const completed = props.progress?.completed_work_items ?? 0;
  const percentage = total === 0 ? 100 : Math.round(completed / total * 100);
  const exceptions = new Map<string, {
    symbol: string;
    state: "skipped" | "failed";
    message: string | null;
  }>();
  const providerSkips = props.progress?.provider_skips
    ?? props.universe?.provider_skips;
  for (const skip of [
    ...(providerSkips?.finviz ?? []),
    ...(providerSkips?.yahoo ?? []),
  ]) {
    exceptions.set(skip.symbol, { ...skip, state: "skipped" });
  }
  for (const ticker of props.progress?.ticker_statuses ?? []) {
    if (ticker.state === "skipped" || ticker.state === "failed") {
      exceptions.set(ticker.symbol, {
        symbol: ticker.symbol,
        state: ticker.state,
        message: ticker.message,
      });
    }
  }

  return (
    <div className="panel-status market-health-progress" data-testid="market-health-progress">
      <Typography color={props.error === undefined ? "text.secondary" : "error"}>
        {props.error ?? statusText(props.universe, props.loading, props.phase)}
      </Typography>
      {props.universe !== null && props.progress != null && total > 0 && (
        <>
          <div className="market-health-progress-control">
            <div className="market-health-progress-bar">
              <i style={{ width: `${percentage}%` }} />
            </div>
            {(props.phase === "running" || props.phase === "paused") && (
              <Button
                size="small"
                data-testid="market-health-pause-resume"
                onClick={() => void (
                  props.phase === "running"
                    ? props.onLifecycle("pause")
                    : props.progress?.yahoo.state === "failed"
                      ? props.onRetry()
                      : props.onLifecycle("resume")
                )}
              >
                {props.phase === "running"
                  ? "Pause"
                  : props.progress?.yahoo.state === "failed"
                    ? "Retry"
                    : "Resume"}
              </Button>
            )}
          </div>
          <Typography>
            Progress {percentage}% · {completed}/{total} work items · {props.progress.completed_tickers}/{props.progress.total_tickers} tickers
          </Typography>
          <Typography color="text.secondary">
            {props.progress.cached_count} cached · {props.progress.refreshed_count} refreshed
          </Typography>
          <ProgressRow label="Resolve ticker information" step={props.progress.finviz} />
          <ProgressRow label="Refresh candles" step={props.progress.yahoo} />
          {[...exceptions.values()].map((ticker) => (
            <Typography key={`${ticker.symbol}-${ticker.state}`} color={ticker.state === "failed" ? "error" : "text.secondary"}>
              {ticker.state === "failed" ? "❌" : "⚠️"} {ticker.symbol}
              {ticker.message !== null ? `: ${ticker.message}` : ""}
            </Typography>
          ))}
        </>
      )}
    </div>
  );
}

function ReadyContent({ tab, rs, threshold, pageError, onLatestSession }: {
  tab: Tab;
  rs: Rs;
  threshold: number;
  pageError?: string;
  onLatestSession: (latestSession: string) => void;
}) {
  const [content, setContent] = useState<MarketHealthTabResponse>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    const controller = new AbortController();
    fetchMarketHealthTab(tab, rs, threshold, controller.signal)
      .then((response) => {
        setError(undefined);
        setContent(response);
        onLatestSession(response.latest_session);
      })
      .catch((requestError: unknown) => {
        if (!(requestError instanceof Error && requestError.name === "AbortError")) {
          setError(errorMessage(requestError, "Unable to calculate tab"));
        }
      });
    return () => controller.abort();
  }, [onLatestSession, rs, tab, threshold]);

  return (
    <div className={`market-health-content market-health-content-${tab}`}>
      {(pageError ?? error) !== undefined && (
        <Typography color="error">{pageError ?? error}</Typography>
      )}
      {content === undefined ? (
        <div className="market-health-loading" role="status">
          <CircularProgress size="1.5rem" />
          <Typography color="text.secondary">
            Loading {tabs.find(([value]) => value === tab)?.[1]}
          </Typography>
        </div>
      ) : (
        <>
          {content.charts.length > 0 && (
            <div className={`market-health-chart-grid market-health-chart-grid-${tab}`}>
              {content.charts.map((chart) => (
                <MarketHealthChart chart={chart} key={chart.title} />
              ))}
            </div>
          )}
          {tab === "leader_lists" && <LeaderLists data={content} />}
        </>
      )}
    </div>
  );
}

function statusText(
  universe: MarketHealthUniverse | null,
  loading: boolean,
  phase: MarketHealthJobSnapshot["phase"],
) {
  if (universe === null) return loading ? "Loading Market Health universe" : "Upload a CSV to define the universe";
  if (phase === "parsing") return "Reading CSV";
  if (phase === "pausing") return "Pausing preparation";
  if (phase === "paused") return "Preparation paused";
  if (phase === "failed") return "Preparation failed. Upload a CSV to replace this job.";
  if (phase === "stale") return "Market Health data is stale";
  return `Preparing data for ${universe.file_name}`;
}

function ProgressRow({ label, step }: { label: string; step: MarketHealthProgressStep }) {
  const icon = step.state === "completed" ? "✅" : step.state === "failed" ? "❌" : "⏳";
  return (
    <Typography>
      {icon} {label} ({step.completed}/{step.total}) · {formatDuration(step.elapsed_seconds)}
      {step.current_symbol !== null ? ` · ${step.current_symbol}` : ""}
      {step.message !== null ? ` · ${step.message}` : ""}
    </Typography>
  );
}

function LeaderLists({ data }: { data: MarketHealthTabResponse }) {
  return (
    <div className="market-health-leaders">
      <LeaderList title="Leaders" leaders={data.leaders} />
      <LeaderList title="Healthy Leaders" leaders={data.healthy_leaders} />
    </div>
  );
}

function LeaderList({ title, leaders }: {
  title: string;
  leaders: MarketHealthTabResponse["leaders"];
}) {
  const [sort, setSort] = useState<{
    column: LeaderSortColumn;
    direction: "asc" | "desc";
  }>({ column: "percentile", direction: "desc" });
  const sortedLeaders = useMemo(
    () => [...leaders].sort((left, right) => compareLeaders(left, right, sort)),
    [leaders, sort],
  );
  const changeSort = (column: LeaderSortColumn) => {
    setSort((current) => current.column === column
      ? { column, direction: current.direction === "asc" ? "desc" : "asc" }
      : { column, direction: column === "percentile" ? "desc" : "asc" });
  };
  const sortableHeader = (column: LeaderSortColumn, label: string) => (
    <TableSortLabel
      active={sort.column === column}
      direction={sort.column === column ? sort.direction : "asc"}
      onClick={() => changeSort(column)}
    >
      {label}
    </TableSortLabel>
  );

  return (
    <section className="market-health-leader-list">
      <Typography component="h2">{title}</Typography>
      <div className="market-health-leader-table">
        <Table stickyHeader size="small" aria-label={title}>
          <TableHead>
            <TableRow>
              <TableCell sortDirection={sort.column === "symbol" ? sort.direction : false}>
                {sortableHeader("symbol", "Ticker")}
              </TableCell>
              <TableCell
                align="right"
                sortDirection={sort.column === "percentile" ? sort.direction : false}
              >
                {sortableHeader("percentile", "RS")}
              </TableCell>
              <TableCell sortDirection={sort.column === "sector" ? sort.direction : false}>
                {sortableHeader("sector", "Sector")}
              </TableCell>
              <TableCell sortDirection={sort.column === "industry_group" ? sort.direction : false}>
                {sortableHeader("industry_group", "Industry Group")}
              </TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {sortedLeaders.map((leader) => (
              <TableRow key={leader.symbol} hover>
                <TableCell>
                  <a
                    href={tickerMarketWatchUrl(leader.symbol)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {leader.symbol}
                  </a>
                </TableCell>
                <TableCell align="right">
                  <a
                    href={tickerMarketWatchUrl(leader.symbol)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {Math.round(leader.percentile)}
                  </a>
                </TableCell>
                <TableCell>
                  {leader.sector === null || leader.sector_industry_keys.length === 0 ? (
                    "—"
                  ) : (
                    <a
                      href={industriesMarketWatchUrl(leader.sector_industry_keys)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {leader.sector}
                    </a>
                  )}
                </TableCell>
                <TableCell>
                  {leader.industry_key === null || leader.industry_group === null ? (
                    "—"
                  ) : (
                    <a
                      href={industryMarketWatchUrl(leader.industry_key)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {leader.industry_group}
                    </a>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}

type LeaderSortColumn = "symbol" | "percentile" | "sector" | "industry_group";

function compareLeaders(
  left: MarketHealthTabResponse["leaders"][number],
  right: MarketHealthTabResponse["leaders"][number],
  sort: { column: LeaderSortColumn; direction: "asc" | "desc" },
) {
  const leftValue = left[sort.column];
  const rightValue = right[sort.column];
  if (leftValue === null) return rightValue === null ? 0 : 1;
  if (rightValue === null) return -1;
  const comparison = typeof leftValue === "number"
    ? leftValue - (rightValue as number)
    : leftValue.localeCompare(rightValue as string);
  return sort.direction === "asc" ? comparison : -comparison;
}

function formatDuration(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes === 0 ? `${remainder}s` : `${minutes}m ${remainder}s`;
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}
