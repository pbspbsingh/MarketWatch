import { useEffect, useId, useRef, useState } from "react";
import AutoAwesomeOutlinedIcon from "@mui/icons-material/AutoAwesomeOutlined";
import NewspaperOutlinedIcon from "@mui/icons-material/NewspaperOutlined";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import RefreshIcon from "@mui/icons-material/Refresh";
import CheckRoundedIcon from "@mui/icons-material/CheckRounded";
import ErrorOutlineRoundedIcon from "@mui/icons-material/ErrorOutlineRounded";
import ScheduleRoundedIcon from "@mui/icons-material/ScheduleRounded";
import CloseRoundedIcon from "@mui/icons-material/CloseRounded";
import SyncAltRoundedIcon from "@mui/icons-material/SyncAltRounded";
import { Alert, Button, Chip, CircularProgress, IconButton, Popover, ToggleButton, ToggleButtonGroup, Typography } from "@mui/material";
import { fetchNFactor, isNFactorActive, refreshNFactor, type NFactorJob, type NFactorJobProgress, type NFactorPhase, type NFactorState, type NewsCoverage, type NewsItem, type NewsSource } from "../api/nFactor";
import "./ticker-n-factor.css";
import { AiOutputPreview } from "./AiOutputPreview";

const sourceLabels: Record<NewsSource, string> = { stock_titan: "Stock Titan", finviz: "Finviz" };
const progressPhases: Record<NFactorPhase, { label: string; stage: number; waiting?: boolean; description: string }> = {
  queued: { label: "Queued", stage: 0, waiting: true, description: "Your refresh is queued and will start shortly." },
  waiting_for_source: { label: "Waiting for news", stage: 0, waiting: true, description: "Waiting for the news source to become available." },
  fetching_news: { label: "Gathering news", stage: 0, description: "Collecting articles from the last six months." },
  waiting_for_ai: { label: "Waiting for AI", stage: 1, waiting: true, description: "Waiting for AI capacity." },
  analyzing: { label: "Analyzing developments", stage: 1, description: "Reviewing the news for new business developments." },
  saving: { label: "Saving report", stage: 2, description: "Analysis complete. Saving the report and its supporting news." },
  completed: { label: "Report saved", stage: 3, description: "Your report and supporting news are ready." },
  failed: { label: "Refresh failed", stage: 0, description: "Try refreshing again." },
};

export function TickerNFactorTab({ symbol }: { symbol: string }) {
  const [source, setSource] = useState<NewsSource>();
  return <NFactorContent key={`${symbol}-${source ?? "auto"}`} symbol={symbol} source={source} onSourceChange={setSource} />;
}

function NFactorContent({ symbol, source, onSourceChange }: { symbol: string; source?: NewsSource; onSourceChange: (source: NewsSource) => void }) {
  const [state, setState] = useState<NFactorState>();
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string>();
  const [startError, setStartError] = useState<string>();
  const [reload, setReload] = useState(0);
  const [selectedNewsId, setSelectedNewsId] = useState<number>();
  const [showCurrentNews, setShowCurrentNews] = useState(false);
  const [activityAnchor, setActivityAnchor] = useState<HTMLButtonElement | null>(null);
  const activityId = useId();
  const startController = useRef<AbortController | undefined>(undefined);
  const evidenceKeyRef = useRef<string | undefined>(undefined);
  const active = isNFactorActive(state?.job);
  const report = state?.report;
  const job = state?.job;
  const otherJobs = state?.other_jobs ?? [];
  const showCurrentProgress = job != null && (active || job.phase === "failed");
  const activeJobs = otherJobs.length + Number(active);
  const selectedSource = source ?? state?.source ?? report?.source ?? "stock_titan";
  const hasRefreshNews = job != null && job.phase !== "completed" && (job.news.length > 0 || job.coverage != null);
  const showingRefreshNews = hasRefreshNews && (report == null || showCurrentNews);
  const news = showingRefreshNews ? job?.news ?? [] : report?.news ?? [];
  const coverage = showingRefreshNews ? job?.coverage : report?.coverage;
  const newsSource = (showingRefreshNews ? job?.source : report?.source) ?? selectedSource;
  const showAiPreview = job != null && (job.phase === "analyzing" || job.phase === "saving" || (job.phase === "failed" && Boolean(job.live_reasoning || job.live_response)));
  const currentProgress = showCurrentProgress ? <JobProgress key={job.id} job={job}>
    {showAiPreview && <AiPreview job={job} />}
  </JobProgress> : null;

  useEffect(() => {
    const controller = new AbortController();
    let timeout: number | undefined;
    let inFlight = false;
    let pollInterval = 5_000;
    const poll = async () => {
      if (inFlight || controller.signal.aborted) return;
      if (timeout !== undefined) window.clearTimeout(timeout);
      inFlight = true;
      try {
        const next = await fetchNFactor(symbol, source, controller.signal);
        if (controller.signal.aborted) return;
        const evidenceKey = `${next.report?.source}-${next.report?.generated_at}-${next.job?.id}`;
        if (evidenceKeyRef.current !== evidenceKey) {
          setSelectedNewsId(undefined);
          setShowCurrentNews(false);
          evidenceKeyRef.current = evidenceKey;
        }
        setState(next);
        setError(undefined);
        pollInterval = isNFactorActive(next.job) || (next.other_jobs?.length ?? 0) > 0 ? 5_000 : 15_000;
      } catch (failure) {
        if (!controller.signal.aborted) setError(errorMessage(failure));
      } finally {
        inFlight = false;
        if (!controller.signal.aborted) {
          setLoading(false);
          if (document.visibilityState === "visible") timeout = window.setTimeout(() => void poll(), pollInterval);
        }
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") void poll();
      else if (timeout !== undefined) window.clearTimeout(timeout);
    };
    void poll();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      controller.abort();
      if (timeout !== undefined) window.clearTimeout(timeout);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [reload, source, symbol]);

  useEffect(() => () => startController.current?.abort(), []);

  const generate = async () => {
    if (starting || active || !state?.ai_enabled) return;
    const controller = new AbortController();
    startController.current = controller;
    setStarting(true);
    setStartError(undefined);
    try {
      const nextJob = await refreshNFactor(symbol, selectedSource, controller.signal);
      if (!controller.signal.aborted) {
        setState((current) => current === undefined ? current : { ...current, job: nextJob });
        setSelectedNewsId(undefined);
        setShowCurrentNews(false);
        setReload((current) => current + 1);
      }
    } catch (failure) {
      if (!controller.signal.aborted) {
        setStartError(errorMessage(failure));
        // A lost POST response may still have started the job; reconcile with a read.
        setReload((current) => current + 1);
      }
    } finally {
      if (!controller.signal.aborted) setStarting(false);
    }
  };

  const selectNews = (id: number) => {
    setShowCurrentNews(false);
    setSelectedNewsId(id);
    window.requestAnimationFrame(() => document.getElementById(`n-factor-news-${id}`)?.scrollIntoView({ behavior: "smooth", block: "nearest" }));
  };

  return (
    <div className="n-factor-tab">
      <div className="n-factor-toolbar">
        <div className="n-factor-controls">
          <ToggleButtonGroup exclusive size="small" color="primary" value={selectedSource} aria-label="News source" onChange={(_, nextSource: NewsSource | null) => {
            if (nextSource !== null) onSourceChange(nextSource);
          }}>
            <ToggleButton value="stock_titan">Stock Titan</ToggleButton>
            <ToggleButton value="finviz">Finviz</ToggleButton>
          </ToggleButtonGroup>
          <Button size="small" variant="contained" disabled={loading || starting || active || !state?.ai_enabled} startIcon={starting ? <CircularProgress size="0.85rem" color="inherit" /> : active ? undefined : report ? <RefreshIcon /> : <AutoAwesomeOutlinedIcon />} onClick={() => void generate()}>
            {starting ? "Starting…" : active ? "In progress" : report ? "Refresh" : "Generate"}
          </Button>
          <Button className="n-factor-activity-button" size="small" variant="outlined" color={job?.phase === "failed" ? "error" : "primary"} disabled={!showCurrentProgress && otherJobs.length === 0}
            aria-label={`N-factor activity, ${activeJobs} active jobs`} aria-haspopup="dialog" aria-expanded={activityAnchor !== null} aria-controls={activityAnchor ? activityId : undefined}
            title={job ? `${symbol}: ${progressPhases[job.phase].label}` : activeJobs > 0 ? `${activeJobs} active N-factor jobs` : "No active N-factor jobs"}
            startIcon={job?.phase === "failed" ? <ErrorOutlineRoundedIcon /> : <ScheduleRoundedIcon />}
            onClick={(event) => setActivityAnchor(event.currentTarget)}>
            <span className="n-factor-activity-label">Activity</span><span className="n-factor-activity-count">{activeJobs}</span>
          </Button>
        </div>
        <Typography className="n-factor-updated" color="text.secondary">
          {report ? <><span>Last updated <time dateTime={report.generated_at}>{new Date(report.generated_at).toLocaleString()}</time></span><span>· {report.model} · {report.news.length} items</span></> : "Last six months · Up to 50 newest articles"}
        </Typography>
      </div>
      {error && <Alert severity="error" action={<Button color="inherit" size="small" onClick={() => setReload((current) => current + 1)}>Retry load</Button>}>{error}</Alert>}
      {startError && <Alert severity="error" onClose={() => setStartError(undefined)}>{startError}</Alert>}
      {state && !state.ai_enabled && <Alert severity="info">Configure AI to generate an N-Factor report. Saved reports remain available.</Alert>}
      <Popover open={activityAnchor !== null} anchorEl={activityAnchor} onClose={() => setActivityAnchor(null)} disableScrollLock
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }} transformOrigin={{ vertical: "top", horizontal: "right" }}
        slotProps={{ paper: { id: activityId, className: "n-factor-activity-popover", role: "dialog", "aria-label": "N-factor activity" } }}>
        <div className="n-factor-activity-heading"><Typography component="h3">N-factor activity</Typography><IconButton size="small" aria-label="Close activity" onClick={() => setActivityAnchor(null)}><CloseRoundedIcon /></IconButton></div>
        {(showCurrentProgress || otherJobs.length > 0) ? <div className="n-factor-progress-grid">
          {showCurrentProgress && <section className="n-factor-progress-column" aria-label="Current ticker progress">
            {currentProgress}
          </section>}
          {otherJobs.length > 0 && <section className="n-factor-progress-column" aria-label="Other ticker progress">
            <Typography component="h4" className="n-factor-progress-label">Other tickers <Chip size="small" variant="outlined" label={otherJobs.length} /></Typography>
            <div className="n-factor-progress-list">
              {otherJobs.map((otherJob) => <JobProgress key={otherJob.id} job={otherJob} compact />)}
            </div>
          </section>}
        </div> : <Typography className="n-factor-activity-empty" color="text.secondary">No active N-factor jobs.</Typography>}
      </Popover>
      {loading && !state ? <div className="panel-status"><CircularProgress size="1rem" /><Typography color="text.secondary">Loading saved report</Typography></div> : (
        <div className="n-factor-grid">
          <section className="n-factor-panel" aria-label="N-Factor findings">
            <div className="n-factor-panel-heading"><AutoAwesomeOutlinedIcon /><Typography component="h3">Potential N-Factors</Typography>{report && <Chip size="small" variant="outlined" label={`${report.findings.length} candidates`} />}</div>
            <div className="n-factor-panel-body">
              {report ? <>
                <Typography className="n-factor-overview">{report.overview}</Typography>
                {report.findings.length === 0 && report.news.length > 0 && <Typography color="text.secondary">No clear N-factor identified in the fetched news window.</Typography>}
                {report.findings.map((finding, index) => <article className="n-factor-finding" key={index}>
                  <div className="n-factor-finding-heading"><Typography component="h4">{finding.title}</Typography><Chip size="small" variant="outlined" label={finding.category} /></div>
                  <Typography>{finding.what_is_new}</Typography>
                  <div className="n-factor-impact"><Typography component="h5">Potential business impact</Typography><Typography>{finding.potential_impact}</Typography></div>
                  <div className="n-factor-uncertainty"><Typography component="h5">What remains uncertain</Typography><Typography color="text.secondary">{finding.uncertainty}</Typography></div>
                  <div className="n-factor-evidence"><span>Supporting news</span>{[...new Set(finding.evidence_ids)].map((id) => {
                    const item = report.news.find((item) => item.id === id);
                    return item ? <Button size="small" key={id} title={item.title} onClick={() => selectNews(id)}>#{id}</Button> : null;
                  })}</div>
                </article>)}
                {report.news.length > 0 && <Typography className="n-factor-note" color="text.secondary">Based on the fetched news window. Potential developments are AI assessments, with supporting evidence and uncertainties above.</Typography>}
              </> : currentProgress ?? <div className="n-factor-empty"><AutoAwesomeOutlinedIcon /><Typography component="h4">What’s new at {symbol}?</Typography><Typography color="text.secondary">Find potential products, contracts, management changes, acquisitions, expansion, and industry developments.</Typography><Typography color="text.secondary">Choose a source and generate a report. Results and supporting news will be saved here.</Typography></div>}
            </div>
          </section>
          <section className="n-factor-panel" aria-label="Source news">
            <div className="n-factor-panel-heading"><NewspaperOutlinedIcon /><Typography component="h3">News · {sourceLabels[newsSource]}</Typography><Chip size="small" variant="outlined" label={`${news.length} items`} />
              <IconButton className="n-factor-news-switch" size="small" disabled={!hasRefreshNews || !report}
                aria-label={showingRefreshNews ? "Show saved report news" : "Show current refresh news"} aria-pressed={showingRefreshNews && report != null}
                title={showingRefreshNews ? "Show saved report news" : "Show current refresh news"}
                onClick={() => { setShowCurrentNews(!showingRefreshNews); setSelectedNewsId(undefined); }}><SyncAltRoundedIcon /></IconButton>
            </div>
            <div className="n-factor-panel-body">
              {(coverage || news.length > 0) && <CoverageCaption news={news} coverage={coverage} />}
              {news.length > 0 ? <>
                <Typography className="n-factor-note" color="text.secondary">{showingRefreshNews ? "News from the current refresh." : `Fetched ${new Date(report?.news_fetched_at ?? "").toLocaleString()}.`} {newsSource === "stock_titan" ? "Summaries provided by Stock Titan AI." : "Finviz provides headlines; summaries may be unavailable."}</Typography>
                {news.map((item) => <NewsArticle key={`${showingRefreshNews ? job?.id : report?.generated_at}-${item.url}`} item={item} selected={selectedNewsId === item.id} />)}
              </> : <div className="n-factor-empty"><NewspaperOutlinedIcon /><Typography component="h4">News behind the analysis</Typography><Typography color="text.secondary">{coverage?.stop_reason === "source_not_found" ? "The source news page is unavailable (HTTP 404)." : coverage ? "No articles available in the requested six-month window." : "Titles, summaries, dates, and source links appear here after news is fetched."}</Typography></div>}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

function NewsArticle({ item, selected }: { item: NewsItem; selected: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const summaryId = useId();
  const headline = <><span className="n-factor-news-number">#{item.id}</span><span className="n-factor-news-headline">{item.title}</span></>;
  return <article id={`n-factor-news-${item.id}`} className={`n-factor-news${selected ? " n-factor-news-selected" : ""}`}>
    <div className="n-factor-news-heading">
      {item.summary ? <button type="button" className="n-factor-news-title n-factor-news-toggle" aria-expanded={expanded} aria-controls={summaryId} title={item.title} onClick={() => setExpanded((current) => !current)}>{headline}</button> : <div className="n-factor-news-title" title={item.title}>{headline}</div>}
      <a href={item.url} target="_blank" rel="noreferrer" className="n-factor-news-link" aria-label={`Open article: ${item.title}`} title="Open article"><OpenInNewIcon /></a>
    </div>
    <div className="n-factor-news-meta"><time dateTime={item.published_at ?? undefined}>{item.published_at ? new Date(item.published_at).toLocaleString() : "Publication date unavailable"}</time></div>
    {item.summary && <Typography id={summaryId} hidden={!expanded} className="n-factor-news-summary">{item.summary}</Typography>}
  </article>;
}

function CoverageCaption({ news, coverage }: { news: NewsItem[]; coverage: NewsCoverage | null | undefined }) {
  const dates = news.flatMap((item) => item.published_at ? [Date.parse(item.published_at)] : []).filter(Number.isFinite);
  const range = dates.length > 0 ? `${new Date(Math.min(...dates)).toLocaleDateString()} – ${new Date(Math.max(...dates)).toLocaleDateString()}` : undefined;
  const reason = coverage ? {
    six_months: "Six-month cutoff reached",
    article_limit: "50-article limit reached",
    source_exhausted: "End of available source history",
    source_limited: "Limited to available Finviz headlines",
    source_not_found: "Source news page unavailable (HTTP 404)",
  }[coverage.stop_reason] : undefined;
  return <Typography className="n-factor-note n-factor-coverage" color="text.secondary">
    {range && <span>Coverage {range}</span>}
    {reason && <span>{reason} · {coverage?.pages_fetched} {coverage?.pages_fetched === 1 ? "page" : "pages"}</span>}
  </Typography>;
}

function AiPreview({ job }: { job: NFactorJob }) {
  return <AiOutputPreview content={job.live_response || job.live_reasoning} status={job.phase === "failed" ? "Interrupted" : job.live_response ? "Writing report" : job.live_reasoning ? "Reasoning" : "Awaiting response"} />;
}

function JobProgress({ job, compact = false, children }: { job: NFactorJobProgress; compact?: boolean; children?: React.ReactNode }) {
  const [now, setNow] = useState(() => Date.now());
  const active = isNFactorActive(job);
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [active]);
  const elapsed = Math.max(0, Math.floor(((active ? now : Date.parse(job.updated_at)) - Date.parse(job.started_at)) / 1_000));
  const countdown = job.retry_at ? Math.max(0, Math.ceil((Date.parse(job.retry_at) - now) / 1_000)) : undefined;
  const phase = progressPhases[job.phase];
  const waiting = phase.waiting;
  const failed = job.phase === "failed";
  const stage = failed && job.ai_activity_at != null ? 1 : phase.stage;
  const description = job.error ?? (countdown !== undefined ? "The news source is rate limited. Fetching will resume automatically."
    : job.phase === "waiting_for_ai" && job.background ? "Waiting for AI to be idle."
    : job.phase === "analyzing" && !job.ai_activity_at ? "The request has started. Waiting for the model to respond."
    : phase.description);
  const statusIcon = failed ? <ErrorOutlineRoundedIcon /> : waiting ? <ScheduleRoundedIcon /> : active ? <CircularProgress size="1.05rem" color="inherit" /> : <CheckRoundedIcon />;
  const activityTime = job.ai_activity_at ? new Date(job.ai_activity_at) : undefined;
  const activityAge = activityTime ? Math.max(0, Math.floor(((active ? now : Date.parse(job.updated_at)) - activityTime.getTime()) / 1_000)) : undefined;
  return <div className={`n-factor-progress${compact ? " n-factor-progress-compact" : ""}${failed ? " n-factor-progress-failed" : ""}${waiting ? " n-factor-progress-waiting" : ""}`}>
    <div className="n-factor-progress-heading">
      <span className="n-factor-progress-symbol">{job.symbol}</span>
      <span className="n-factor-progress-source">{sourceLabels[job.source]}</span>
      <span className="n-factor-progress-origin">{job.background ? "Background" : "Manual"}</span>
      {compact && <span className="n-factor-progress-elapsed">{formatDuration(elapsed)}</span>}
    </div>
    <div className="n-factor-progress-status" role="status"><span className="n-factor-progress-status-icon" aria-hidden="true">{statusIcon}</span><strong>{phase.label}</strong></div>
    {!compact && <ol className="n-factor-progress-stages" aria-label="Report stages">
      {["News", "Analysis", "Saved"].map((label, index) => <li key={label} className={index < stage ? "is-complete" : index === stage && !failed ? "is-current" : ""} aria-current={index === stage && !failed ? "step" : undefined}>
        <span className="n-factor-progress-step" aria-hidden="true">{index < stage ? <CheckRoundedIcon /> : index + 1}</span><span>{label}</span>
      </li>)}
    </ol>}
    {(waiting || failed || (job.phase === "analyzing" && !job.ai_activity_at)) && <Typography className="n-factor-progress-description" color="text.secondary">{description}</Typography>}
    {countdown !== undefined && active && <div className="n-factor-progress-retry"><ScheduleRoundedIcon /><span>{countdown > 0 ? <>Retrying in <strong>{formatDuration(countdown)}</strong></> : "Retry is due · waiting for the source"}</span></div>}
    {!compact && <dl className="n-factor-progress-metrics">
      <div><dt>Elapsed</dt><dd>{formatDuration(elapsed)}</dd></div>
      <div><dt>Articles</dt><dd>{job.news_count}</dd></div>
      {job.pages_fetched > 0 && <div><dt>Pages</dt><dd>{job.pages_fetched}</dd></div>}
      {activityTime && activityAge !== undefined && <div><dt>Last AI activity</dt><dd>{active ? activityAge === 0 ? "Just now" : `${formatDuration(activityAge)} ago` : <time dateTime={activityTime.toISOString()} title={activityTime.toLocaleString()}>{activityTime.toLocaleTimeString()}</time>}</dd></div>}
    </dl>}
    {compact && job.news_count > 0 && <div className="n-factor-progress-compact-meta">{job.news_count} articles{job.pages_fetched > 0 && ` · ${job.pages_fetched} ${job.pages_fetched === 1 ? "page" : "pages"}`}</div>}
    {children}
  </div>;
}

function formatDuration(seconds: number) {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3_600)}h ${Math.floor((seconds % 3_600) / 60)}m`;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "N-Factor request failed";
}
