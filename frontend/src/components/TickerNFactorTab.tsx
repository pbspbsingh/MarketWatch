import { useEffect, useId, useRef, useState } from "react";
import AutoAwesomeOutlinedIcon from "@mui/icons-material/AutoAwesomeOutlined";
import NewspaperOutlinedIcon from "@mui/icons-material/NewspaperOutlined";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import RefreshIcon from "@mui/icons-material/Refresh";
import { Alert, Button, Chip, CircularProgress, ToggleButton, ToggleButtonGroup, Typography } from "@mui/material";
import { fetchNFactor, isNFactorActive, refreshNFactor, type NFactorJob, type NFactorJobProgress, type NFactorPhase, type NFactorState, type NewsCoverage, type NewsItem, type NewsSource } from "../api/nFactor";
import "./ticker-n-factor.css";

const sourceLabels: Record<NewsSource, string> = { stock_titan: "Stock Titan", finviz: "Finviz" };
const phaseLabels: Record<NFactorPhase, string> = {
  queued: "Queued", waiting_for_source: "Waiting for source", fetching_news: "Fetching news",
  waiting_for_ai: "Waiting for AI",
  analyzing: "AI analysis", saving: "Saving report", completed: "Report saved", failed: "Refresh failed",
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
  const startController = useRef<AbortController | undefined>(undefined);
  const evidenceKeyRef = useRef<string | undefined>(undefined);
  const active = isNFactorActive(state?.job);
  const report = state?.report;
  const job = state?.job;
  const otherJobs = state?.other_jobs ?? [];
  const showCurrentProgress = job != null && (active || job.phase === "failed");
  const selectedSource = source ?? state?.source ?? report?.source ?? "stock_titan";
  const hasRefreshNews = job != null && job.phase !== "completed" && (job.news.length > 0 || job.coverage != null);
  const showingRefreshNews = hasRefreshNews && (report == null || showCurrentNews);
  const news = showingRefreshNews ? job?.news ?? [] : report?.news ?? [];
  const coverage = showingRefreshNews ? job?.coverage : report?.coverage;
  const newsSource = (showingRefreshNews ? job?.source : report?.source) ?? selectedSource;
  const aiPreview = job && (job.phase === "analyzing" || job.phase === "saving" || (job.phase === "failed" && (job.live_reasoning || job.live_response)))
    ? <AiPreview key={job.id} job={job} /> : null;

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
          <Button size="small" variant="contained" disabled={loading || starting || active || !state?.ai_enabled} startIcon={starting || active ? <CircularProgress size="0.85rem" color="inherit" /> : report ? <RefreshIcon /> : <AutoAwesomeOutlinedIcon />} onClick={() => void generate()}>
            {starting ? "Starting…" : active ? "In progress" : report ? "Refresh" : "Generate"}
          </Button>
        </div>
        <Typography className="n-factor-updated" color="text.secondary">
          {report ? <><span>Last updated <time dateTime={report.generated_at}>{new Date(report.generated_at).toLocaleString()}</time></span><span>· {report.model} · {report.news.length} items</span></> : "Last six months · Up to 50 newest articles"}
        </Typography>
      </div>
      {error && <Alert severity="error" action={<Button color="inherit" size="small" onClick={() => setReload((current) => current + 1)}>Retry load</Button>}>{error}</Alert>}
      {startError && <Alert severity="error" onClose={() => setStartError(undefined)}>{startError}</Alert>}
      {state && !state.ai_enabled && <Alert severity="info">Configure AI to generate an N-Factor report. Saved reports remain available.</Alert>}
      {(showCurrentProgress || otherJobs.length > 0) && <div className={`n-factor-progress-grid${otherJobs.length === 0 ? " n-factor-progress-single" : ""}`}>
        <section className="n-factor-progress-column" aria-label="Current ticker progress">
          <Typography component="h4" className="n-factor-progress-label">{symbol} · Current ticker</Typography>
          {showCurrentProgress ? <JobProgress key={job.id} job={job} previousReport={report != null} /> : <Typography className="n-factor-progress-idle" color="text.secondary">No N-Factor job is running for {symbol}.</Typography>}
        </section>
        {otherJobs.length > 0 && <section className="n-factor-progress-column" aria-label="Other ticker progress">
          <Typography component="h4" className="n-factor-progress-label">Other tickers <Chip size="small" variant="outlined" label={otherJobs.length} /></Typography>
          <div className="n-factor-progress-list">
            {otherJobs.map((otherJob) => <JobProgress key={otherJob.id} job={otherJob} previousReport={false} showSymbol />)}
          </div>
        </section>}
      </div>}
      {loading && !state ? <div className="panel-status"><CircularProgress size="1rem" /><Typography color="text.secondary">Loading saved report</Typography></div> : (
        <div className="n-factor-grid">
          <section className="n-factor-panel" aria-label="N-Factor findings">
            <div className="n-factor-panel-heading"><AutoAwesomeOutlinedIcon /><Typography component="h3">Potential N-Factors</Typography>{report && <Chip size="small" variant="outlined" label={`${report.findings.length} candidates`} />}</div>
            <div className={`n-factor-panel-body${!report && aiPreview ? " n-factor-panel-body-live" : ""}`}>
              {report ? <>
                {aiPreview}
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
              </> : <><div className="n-factor-empty"><AutoAwesomeOutlinedIcon /><Typography component="h4">What’s new at {symbol}?</Typography><Typography color="text.secondary">Find potential products, contracts, management changes, acquisitions, expansion, and industry developments.</Typography><Typography color="text.secondary">Choose a source and generate a report. Results and supporting news will be saved here.</Typography></div>{aiPreview}</>}
            </div>
          </section>
          <section className="n-factor-panel" aria-label="Source news">
            <div className="n-factor-panel-heading"><NewspaperOutlinedIcon /><Typography component="h3">News · {sourceLabels[newsSource]}</Typography><Chip size="small" variant="outlined" label={`${news.length} items`} /></div>
            <div className="n-factor-panel-body">
              {hasRefreshNews && report && <div className="n-factor-news-switch"><Button size="small" variant={!showingRefreshNews ? "outlined" : "text"} onClick={() => setShowCurrentNews(false)}>Saved report</Button><Button size="small" variant={showingRefreshNews ? "outlined" : "text"} onClick={() => { setShowCurrentNews(true); setSelectedNewsId(undefined); }}>Current refresh</Button></div>}
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
  const previewRef = useRef<HTMLDivElement>(null);
  const response = job.live_response || job.live_reasoning;
  useEffect(() => {
    if (previewRef.current) previewRef.current.scrollTop = previewRef.current.scrollHeight;
  }, [response]);
  return <div className="ticker-ai-preview n-factor-ai-preview" ref={previewRef}>
    <Typography component="h4">{job.phase === "failed" ? "Interrupted AI response" : job.live_response ? "Generating report" : job.live_reasoning ? "Model reasoning" : "Waiting for AI"}</Typography>
    <Typography component="pre" className="ticker-ai-stream">{response || "The AI request is in progress…"}</Typography>
  </div>;
}

function JobProgress({ job, previousReport, showSymbol = false }: { job: NFactorJobProgress; previousReport: boolean; showSymbol?: boolean }) {
  const [now, setNow] = useState(() => Date.now());
  const active = isNFactorActive(job);
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [active]);
  const elapsed = Math.max(0, Math.floor(((active ? now : Date.parse(job.updated_at)) - Date.parse(job.started_at)) / 1_000));
  const countdown = job.retry_at ? Math.max(0, Math.ceil((Date.parse(job.retry_at) - now) / 1_000)) : undefined;
  return <div className={`n-factor-progress${job.phase === "failed" ? " n-factor-progress-failed" : ""}`} role="status">
    <div className="n-factor-progress-heading">{active && <CircularProgress size="0.9rem" />}{showSymbol && <strong>{job.symbol}</strong>}<strong>{phaseLabels[job.phase]}</strong><span>{job.background ? "Background" : "Manual"} · {sourceLabels[job.source]}</span><span>{Math.floor(elapsed / 60)}m {elapsed % 60}s</span>{job.pages_fetched > 0 && <span>{job.pages_fetched} {job.pages_fetched === 1 ? "page" : "pages"} fetched</span>}{job.news_count > 0 && <span>{job.news_count} news items</span>}</div>
    <Typography color="text.secondary">{job.error ?? (countdown !== undefined ? `Rate limited (HTTP 429) · retrying in ${countdown}s` : job.phase === "waiting_for_source" ? "Waiting for another source request to finish" : job.phase === "waiting_for_ai" ? job.background ? "Waiting for user-started AI work to finish and the idle delay to expire" : "Waiting for AI capacity" : job.phase === "analyzing" ? job.ai_activity_at ? "AI is processing the news" : "Waiting for the AI response" : "You can close this window; processing will continue while the server is running.")}{previousReport && " Previous report remains visible until a new report is saved."}</Typography>
  </div>;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "N-Factor request failed";
}
