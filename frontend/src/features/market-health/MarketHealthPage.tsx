import { useEffect, useMemo, useRef, useState } from "react";
import FileDownloadOutlinedIcon from "@mui/icons-material/FileDownloadOutlined";
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
  Checkbox,
  FormControlLabel,
  MenuItem,
  Popover,
  Select,
  Slider,
  TablePagination,
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
import { SplitPane } from "../../components/SplitPane";
import { synchronizeLineChartGroup, type LineChartSyncTarget } from "../../components/lightweight-chart/chartSync";
import {
  industryMarketWatchUrl,
  tickerMarketWatchUrl,
} from "../ticker-lens/utils";
import "./market-health.css";

const tabs = [
  ["market_breadth", "Market Breadth"],
  ["industries", "Industries"],
  ["themes", "Themes"],
  ["leading_stocks", "Leading Stocks"],
] as const;

type Tab = (typeof tabs)[number][0];

export function MarketHealthPage() {
  const [universe, setUniverse] = useState<MarketHealthUniverse | null>(null);
  const [snapshot, setSnapshot] = useState<MarketHealthJobSnapshot>({
    revision: 0,
    phase: "no_universe",
  });
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string>();
  const [tab, setTab] = useState<Tab>("market_breadth");
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
            <>
              Universe: <strong>{universe.file_name}</strong> · {usableCount}/{universe.imported_count} Tickers
              {snapshot.phase === "ready" && latestSession !== undefined ? ` · ${latestSession}` : ""}
            </>
          )}
        </Typography>
        {snapshot.phase === "ready" && (
          <ReadyControls
            tab={tab}
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
  tab: Tab;
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
  const hasProgress = props.universe !== null && props.progress != null && total > 0;
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
    <div className={`panel-status market-health-progress${hasProgress ? "" : " market-health-empty"}`} data-testid="market-health-progress">
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

function ReadyContent({ tab, pageError, onLatestSession }: {
  tab: Tab;
  pageError?: string;
  onLatestSession: (latestSession: string) => void;
}) {
  const [content, setContent] = useState<MarketHealthTabResponse>();
  const [error, setError] = useState<string>();
  const [group, setGroup] = useState<string>();
  const [leaderSessions, setLeaderSessions] = useState(63);
  const [draftSessions, setDraftSessions] = useState(63);
  const [lookbackAnchor, setLookbackAnchor] = useState<HTMLElement | null>(null);
  const [groupSplit, setGroupSplit] = useState(40);
  const requestKey = `${tab}:${group ?? ""}:${leaderSessions}`;
  const [loadedKey, setLoadedKey] = useState<string>();

  useEffect(() => {
    const controller = new AbortController();
    fetchMarketHealthTab(tab, group, controller.signal, leaderSessions)
      .then((response) => {
        if (controller.signal.aborted) return;
        setError(undefined);
        setContent(response);
        setLoadedKey(requestKey);
        onLatestSession(response.latest_session);
      })
      .catch((requestError: unknown) => {
        if (!controller.signal.aborted && !(requestError instanceof Error && requestError.name === "AbortError")) {
          setError(errorMessage(requestError, "Unable to calculate tab"));
        }
      });
    return () => controller.abort();
  }, [group, leaderSessions, onLatestSession, requestKey, tab]);

  return (
    <div className={`market-health-content market-health-content-${tab}`}>
      {tab === "leading_stocks" && (
        <>
          <Button
            className="market-health-lookback-toggle"
            size="small"
            aria-label="Leader lookback"
            aria-haspopup="dialog"
            aria-expanded={lookbackAnchor !== null}
            aria-controls={lookbackAnchor === null ? undefined : "leader-lookback-dialog"}
            onClick={event => setLookbackAnchor(event.currentTarget)}
          >
            Lookback: {leaderSessions} sessions
          </Button>
          <Popover
            open={lookbackAnchor !== null}
            anchorEl={lookbackAnchor}
            onClose={() => setLookbackAnchor(null)}
            anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
            transformOrigin={{ vertical: "top", horizontal: "right" }}
          >
            <div id="leader-lookback-dialog" className="market-health-lookback" role="dialog" aria-labelledby="leader-lookback-label">
              <Typography id="leader-lookback-label">Leader lookback: {draftSessions} trading sessions</Typography>
              <Slider aria-labelledby="leader-lookback-label" min={20} max={252} step={1}
                value={draftSessions} valueLabelDisplay="auto"
                marks={[{value:20,label:"20"},{value:63,label:"63"},{value:126,label:"126"},{value:252,label:"252"}]}
                onChange={(_, value) => setDraftSessions(value as number)}
                onChangeCommitted={(_, value) => setLeaderSessions(value as number)} />
            </div>
          </Popover>
        </>
      )}
      {(pageError ?? error) !== undefined && (
        <Typography color="error">{pageError ?? error}</Typography>
      )}
      {content === undefined || loadedKey !== requestKey ? (
        <div className="market-health-loading" role="status">
          <CircularProgress size="1.5rem" />
          <Typography color="text.secondary">
            Loading {tabs.find(([value]) => value === tab)?.[1]}
          </Typography>
        </div>
      ) : (
        <>
          <Typography className="market-health-overview" variant="body2" color="text.secondary">
            {content.selected_group !== null && <><strong>{content.groups.find(group => group.key === content.selected_group)?.name}</strong> · </>}
            {content.eligible_count} / {content.universe_count} stocks eligible · ADV20 &gt; $10M · Benchmark: {content.benchmark}
            {tab !== "leading_stocks" && <><br />Current membership applied historically. Changes are percentage points and include liquidity membership changes.</>}
          </Typography>
          {tab === "industries" || tab === "themes" ? (
            <SplitPane
              orientation="horizontal"
              initialSplit={groupSplit}
              onSplitChange={setGroupSplit}
              first={(
                <div className="market-health-group-panel">
                  <GroupTable data={content} selected={group} onSelect={setGroup} />
                  {content.selected_group !== null && (
                    <div className="market-health-members">
                      <Typography component="h2">Eligible group members ({content.group_members.length})</Typography>
                      {content.group_members.map(symbol => (
                        <a key={symbol} href={tickerMarketWatchUrl(symbol)} target="_blank" rel="noreferrer">{symbol}</a>
                      ))}
                    </div>
                  )}
                </div>
              )}
              second={<SynchronizedCharts charts={content.charts} tab={tab} />}
            />
          ) : content.charts.length > 0 && (
            <SynchronizedCharts charts={content.charts} tab={tab} />
          )}
          {tab === "leading_stocks" && <LeadingStocks data={content} />}
        </>
      )}
    </div>
  );
}

function SynchronizedCharts({ charts, tab }: { charts: MarketHealthTabResponse["charts"]; tab: Tab }) {
  const targets = useRef<(LineChartSyncTarget | null)[]>([]);
  const [revision, setRevision] = useState(0);
  const chartCount = charts.length;
  const handlers = useMemo(() => Array.from({ length: chartCount }, (_, index) => (target: LineChartSyncTarget | null) => {
    targets.current[index] = target;
    setRevision(value => value + 1);
  }), [chartCount]);
  useEffect(() => {
    const ready = targets.current.filter((target): target is LineChartSyncTarget => target !== null);
    return ready.length === charts.length ? synchronizeLineChartGroup(ready) : undefined;
  }, [charts.length, revision]);
  return <div className={`market-health-chart-grid market-health-chart-grid-${tab}`}>{charts.map((chart,index)=><MarketHealthChart chart={chart} key={chart.title} onSyncTarget={handlers[index]}/>)}</div>;
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

type GroupRow = MarketHealthTabResponse["groups"][number];
const groupColumns = [
  ["above_sma20_percent", "Above 20", "above_sma20_valid_count"],
  ["above_sma50_percent", "Above 50", "above_sma50_valid_count"],
  ["above_sma50_change_5d", "Δ50 · 5D", null],
  ["above_sma50_change_20d", "Δ50 · 20D", null],
  ["new_high_percent", "Highs", "new_high_valid_count"],
  ["new_low_percent", "Lows", "new_low_valid_count"],
  ["outperform_20_percent", "Beat benchmark · 20", "outperform_20_valid_count"],
  ["outperform_63_percent", "Beat benchmark · 63", "outperform_63_valid_count"],
] as const;
type GroupSortColumn = "name" | "eligible_count" | (typeof groupColumns)[number][0];

function GroupTable({ data, selected, onSelect }: {
  data: MarketHealthTabResponse;
  selected?: string;
  onSelect: (key?: string) => void;
}) {
  const [sort, setSort] = useState<{ column: GroupSortColumn; direction: "asc" | "desc" }>({
    column: "outperform_63_percent", direction: "desc",
  });
  const rows = [...data.groups].sort((a, b) => {
    const left = a[sort.column], right = b[sort.column];
    if (left === null) return right === null ? a.name.localeCompare(b.name) : 1;
    if (right === null) return -1;
    const result = typeof left === "number" ? left - (right as number) : left.localeCompare(right as string);
    return (sort.direction === "asc" ? result : -result) || a.name.localeCompare(b.name);
  });
  const header = (column: GroupSortColumn, label: string) => (
    <TableSortLabel active={sort.column === column} direction={sort.column === column ? sort.direction : "desc"}
      onClick={() => setSort(current => ({ column, direction: current.column === column && current.direction === "desc" ? "asc" : "desc" }))}>
      {label.replace("benchmark", data.benchmark)}
    </TableSortLabel>
  );
  const value = (row: GroupRow, column: (typeof groupColumns)[number][0]) => {
    const number = row[column];
    return number === null ? "—" : `${number.toFixed(1)}${column.includes("change") ? " pp" : "%"}`;
  };
  return (
    <section className="market-health-leader-list">
      <Typography component="h2">{data.tab === "themes" ? "Themes" : "Industries"}</Typography>
      <Typography variant="caption" color="text.secondary">
        Select a group to inspect its charts and stocks. Table percentages need ≥10 valid stocks; hover a value for its denominator.
      </Typography>
      {selected !== undefined && <Button size="small" onClick={() => onSelect(undefined)}>Show whole universe</Button>}
      <div className="market-health-leader-table market-health-group-table">
        <Table stickyHeader size="small" aria-label={data.tab === "themes" ? "Theme participation" : "Industry participation"}>
          <TableHead><TableRow>
            <TableCell>{header("name", "Group")}</TableCell>
            <TableCell align="right">{header("eligible_count", "Eligible / Members")}</TableCell>
            {groupColumns.map(([key, label]) => <TableCell key={key} align="right">{header(key, label)}</TableCell>)}
          </TableRow></TableHead>
          <TableBody>{rows.map(row => (
            <TableRow key={row.key} hover selected={selected === row.key}>
              <TableCell><Button size="small" aria-pressed={selected === row.key}
                onClick={() => onSelect(selected === row.key ? undefined : row.key)}>
                {row.name}{row.small_group ? " (small group)" : ""}
              </Button></TableCell>
              <TableCell align="right">{row.eligible_count} / {row.member_count}</TableCell>
              {groupColumns.map(([key, , countKey]) => <TableCell key={key} align="right"
                title={countKey === null ? "Displayed-series change; liquidity membership can change." : `${row[countKey]} valid stocks`}>
                {value(row, key)}
              </TableCell>)}
            </TableRow>
          ))}</TableBody>
        </Table>
      </div>
    </section>
  );
}

function LeadingStocks({ data }: { data: MarketHealthTabResponse }) {
  const [sort, setSort] = useState<{
    column: LeaderSortColumn;
    direction: "asc" | "desc";
  }>({ column: "excess_selected", direction: "desc" });
  const performanceColumns: Array<{ key: "return_20" | "return_selected" | "excess_20" | "excess_selected"; label: string }> = [
    ...(data.leader_sessions === 20 ? [] : [{ key: "return_20" as const, label: "Return 20" }]),
    { key: "return_selected", label: `Return ${data.leader_sessions}` },
    ...(data.leader_sessions === 20 ? [] : [{ key: "excess_20" as const, label: "Excess 20 (pp)" }]),
    { key: "excess_selected", label: `Excess ${data.leader_sessions} (pp)` },
  ];
  const [industry, setIndustry] = useState("");
  const [theme, setTheme] = useState("");
  const [bothRs,setBothRs]=useState(false); const [bothSma,setBothSma]=useState(false); const [newHigh,setNewHigh]=useState(false);
  const industries=useMemo(()=>[...new Set(data.leading_stocks.map(s=>s.industry_group).filter((v):v is string=>v!==null))].sort(),[data]);
  const themes=useMemo(()=>[...new Set(data.leading_stocks.flatMap(s=>s.themes))].sort(),[data]);
  const sortedLeaders = useMemo(() => data.leading_stocks.filter(s=>(!industry||s.industry_group===industry)&&(!theme||s.themes.includes(theme))&&(!bothRs||s.excess_20>0)&&(!bothSma||(s.above_sma20&&s.above_sma50))&&(!newHigh||s.new_high_63)).sort((a,b)=>compareLeaders(a,b,sort)), [data,industry,theme,bothRs,bothSma,newHigh,sort]);
  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(1);
  const tableContainer = useRef<HTMLDivElement>(null);
  const visiblePage = Math.min(page, Math.max(0, Math.ceil(sortedLeaders.length / rowsPerPage) - 1));

  useEffect(() => {
    const container = tableContainer.current;
    const header = container?.querySelector("thead");
    const row = container?.querySelector("tbody tr");
    if (!container || !header || !row) return;
    const measure = () => {
      const rowHeight = row.getBoundingClientRect().height;
      if (rowHeight <= 0) return;
      const available = container.clientHeight - header.getBoundingClientRect().height;
      setRowsPerPage(Math.max(1, Math.floor(available / rowHeight)));
    };
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    observer.observe(header);
    observer.observe(row);
    measure();
    return () => observer.disconnect();
  }, [sortedLeaders, visiblePage]);
  const changeSort = (column: LeaderSortColumn) => {
    setSort((current) => current.column === column
      ? { column, direction: current.direction === "asc" ? "desc" : "asc" }
      : { column, direction: numericLeaderColumns.has(column) ? "desc" : "asc" });
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
    <section className="market-health-leader-list market-health-leading-stocks">
      <div className="market-health-leader-header">
        <Typography component="h2">Leading Stocks vs {data.benchmark}</Typography>
        <Typography variant="caption">Positive {data.leader_sessions}-session excess return. Relative leaders can still have negative returns.</Typography>
        <Select size="small" inputProps={{ "aria-label": "Filter leaders by industry" }} displayEmpty value={industry} onChange={e=>setIndustry(e.target.value)}><MenuItem value="">All industries</MenuItem>{industries.map(v=><MenuItem key={v} value={v}>{v}</MenuItem>)}</Select>
        <Select size="small" inputProps={{ "aria-label": "Filter leaders by theme" }} displayEmpty value={theme} onChange={e=>setTheme(e.target.value)}><MenuItem value="">All themes</MenuItem>{themes.map(v=><MenuItem key={v} value={v}>{v}</MenuItem>)}</Select>
        <FormControlLabel control={<Checkbox size="small" checked={bothRs} onChange={e=>setBothRs(e.target.checked)}/>} label="Both horizons" disabled={data.leader_sessions === 20}/><FormControlLabel control={<Checkbox size="small" checked={bothSma} onChange={e=>setBothSma(e.target.checked)}/>} label="Above both SMAs"/><FormControlLabel control={<Checkbox size="small" checked={newHigh} onChange={e=>setNewHigh(e.target.checked)}/>} label="New 63-session closing high"/>
        <Tooltip title="Export Leading Stocks CSV">
          <span>
            <IconButton
              size="small"
              disabled={sortedLeaders.length === 0}
              aria-label="Export Leading Stocks CSV"
              onClick={() => downloadLeaderCsv(data, sortedLeaders)}
            >
              <FileDownloadOutlinedIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
      </div>
      <div className="market-health-leader-table" ref={tableContainer}>
        <Table stickyHeader size="small" aria-label="Leading Stocks">
          <TableHead>
            <TableRow>
              <TableCell sortDirection={sort.column === "symbol" ? sort.direction : false}>
                {sortableHeader("symbol", "Ticker")}
              </TableCell>
              {performanceColumns.map(({ key, label }) => (
                <TableCell key={key} align="right">{sortableHeader(key, label)}</TableCell>
              ))}
              <TableCell align="center">20/50 SMA</TableCell>
              <TableCell align="right">{sortableHeader("distance_from_high_63", "From 63 High")}</TableCell>
              <TableCell align="right">{sortableHeader("adv20", "ADV20")}</TableCell>
              <TableCell>{sortableHeader("industry_group", "Industry")}</TableCell><TableCell>Themes</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {sortedLeaders.slice(visiblePage * rowsPerPage, (visiblePage + 1) * rowsPerPage).map((leader) => (
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
                {performanceColumns.map(({ key }) => (
                  <TableCell align="right" key={key}>
                    {(leader[key] * 100).toFixed(1)}{key.startsWith("excess") ? " pp" : "%"}
                  </TableCell>
                ))}
                <TableCell align="center">{leader.above_sma20 ? "✓" : "—"} / {leader.above_sma50 === null ? "N/A" : leader.above_sma50 ? "✓" : "—"}</TableCell>
                <TableCell align="right">{leader.distance_from_high_63 === null ? "—" : `${(leader.distance_from_high_63 * 100).toFixed(1)}%`}</TableCell>
                <TableCell align="right">${(leader.adv20 / 1_000_000).toFixed(1)}M</TableCell>
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
                <TableCell>{leader.themes.join(", ") || "—"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {sortedLeaders.length === 0 && <Typography>No stocks match these filters with complete return data.</Typography>}
      <TablePagination component="div" count={sortedLeaders.length} rowsPerPage={rowsPerPage} rowsPerPageOptions={[]} page={visiblePage} onPageChange={(_, value) => setPage(value)} />
    </section>
  );
}

type LeaderSortColumn = "symbol" | "return_20" | "return_selected" | "excess_20" | "excess_selected" | "distance_from_high_63" | "adv20" | "industry_group";
const numericLeaderColumns = new Set<LeaderSortColumn>(["return_20","return_selected","excess_20","excess_selected","distance_from_high_63","adv20"]);

function compareLeaders(
  left: MarketHealthTabResponse["leading_stocks"][number],
  right: MarketHealthTabResponse["leading_stocks"][number],
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

function downloadLeaderCsv(
  data: MarketHealthTabResponse,
  leaders: MarketHealthTabResponse["leading_stocks"],
) {
  const csv = [
    `ticker,benchmark,as_of,${data.leader_sessions === 20 ? "" : "return_20_pct,"}return_${data.leader_sessions}_pct,${data.leader_sessions === 20 ? "" : "excess_20_pp,"}excess_${data.leader_sessions}_pp,above_sma20,above_sma50,distance_from_high_63_pct,new_high_63,adv20_usd,industry,themes`,
    ...leaders.map((leader) => [
      leader.symbol, data.benchmark, data.latest_session,
      ...(data.leader_sessions === 20 ? [leader.return_selected, leader.excess_selected] : [leader.return_20, leader.return_selected, leader.excess_20, leader.excess_selected]).map(value => String(value * 100)),
      String(leader.above_sma20), leader.above_sma50 === null ? "" : String(leader.above_sma50),
      leader.distance_from_high_63 === null ? "" : String(leader.distance_from_high_63 * 100),
      leader.new_high_63 === null ? "" : String(leader.new_high_63), String(leader.adv20),
      leader.industry_group ?? "",
      leader.themes.join(";"),
    ].map(csvCell).join(",")),
  ].join("\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `${data.latest_session}-${data.benchmark}-leaders-${data.leader_sessions}s.csv`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function csvCell(value: string) { return `"${value.replaceAll('"', '""')}"`; }

function formatDuration(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes === 0 ? `${remainder}s` : `${minutes}m ${remainder}s`;
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}
