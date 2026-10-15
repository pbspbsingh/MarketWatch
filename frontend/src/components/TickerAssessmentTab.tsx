import { useEffect, useRef, useState } from "react";
import AutoAwesomeOutlinedIcon from "@mui/icons-material/AutoAwesomeOutlined";
import RefreshIcon from "@mui/icons-material/Refresh";
import FactCheckOutlinedIcon from "@mui/icons-material/FactCheckOutlined";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import { Alert, Button, Chip, CircularProgress, LinearProgress, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Typography } from "@mui/material";
import type { Fundamentals } from "../api/details";
import { fetchFundamentalAssessment, isAssessmentActive, reassessFundamentals, type AssessmentJob, type AssessmentScores, type AssessmentState } from "../api/fundamentalAssessment";
import { AiOutputPreview } from "./AiOutputPreview";
import "./ticker-assessment.css";

const phaseLabels: Record<AssessmentJob["phase"], string> = {
  queued: "Queued",
  fetching_fundamentals: "Refreshing fundamentals",
  waiting_for_ai: "Waiting for AI",
  analyzing: "Analyzing fundamentals",
  saving: "Saving assessment",
  completed: "Assessment complete",
  failed: "Assessment failed",
};

export function TickerAssessmentTab({ symbol, fundamentals }: { symbol: string; fundamentals?: Fundamentals }) {
  return <AssessmentContent key={symbol} symbol={symbol} fundamentals={fundamentals} />;
}

function AssessmentContent({ symbol, fundamentals }: { symbol: string; fundamentals?: Fundamentals }) {
  const [state, setState] = useState<AssessmentState>();
  const [error, setError] = useState<string>();
  const [starting, setStarting] = useState(false);
  const [reload, setReload] = useState(0);
  const startController = useRef<AbortController | undefined>(undefined);
  const active = starting || isAssessmentActive(state?.job);
  const report = state?.report;

  useEffect(() => {
    const controller = new AbortController();
    let timeout: number | undefined;
    let inFlight = false;
    const poll = async () => {
      if (inFlight || controller.signal.aborted) return;
      if (timeout !== undefined) window.clearTimeout(timeout);
      inFlight = true;
      try {
        const next = await fetchFundamentalAssessment(symbol, controller.signal);
        if (!controller.signal.aborted) { setState(next); setError(undefined); }
        if (!controller.signal.aborted && document.visibilityState === "visible") timeout = window.setTimeout(() => void poll(), isAssessmentActive(next.job) ? 750 : 15_000);
      } catch (failure) {
        if (!controller.signal.aborted) {
          setError(failure instanceof Error ? failure.message : "Could not load assessment");
          if (document.visibilityState === "visible") timeout = window.setTimeout(() => void poll(), 5_000);
        }
      } finally {
        inFlight = false;
      }
    };
    const onVisibility = () => { if (document.visibilityState === "visible") void poll(); };
    document.addEventListener("visibilitychange", onVisibility);
    void poll();
    return () => { controller.abort(); if (timeout !== undefined) window.clearTimeout(timeout); document.removeEventListener("visibilitychange", onVisibility); };
  }, [symbol, fundamentals, reload]);

  useEffect(() => () => startController.current?.abort(), []);

  const analyze = async () => {
    if (active) return;
    const controller = new AbortController();
    startController.current = controller;
    setStarting(true);
    setError(undefined);
    try {
      const job = await reassessFundamentals(symbol, controller.signal);
      if (!controller.signal.aborted) { setState(current => current == null ? current : { ...current, job }); setReload(value => value + 1); }
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "Could not start assessment");
    } finally {
      if (!controller.signal.aborted) setStarting(false);
    }
  };

  const job = state?.job;
  const scores = report?.scores;
  const stale = state?.stale;
  const summary = report?.summary ?? "";
  const lastUpdated = report == null ? "" : new Date(report.generated_at).toLocaleString();
  const snapshotAt = report?.fundamentals.fetched_at;
  const concerns = (report?.concerns ?? []).map(concern => `${concern.reason} (${concern.evidence_ids.join(" · ")})`);
  const stage = job?.phase === "queued" || job?.phase === "fetching_fundamentals" ? 0 : job?.phase === "saving" ? 2 : 1;
  return <div className="assessment-tab">
    <div className="assessment-toolbar">
      <div className="assessment-title"><AutoAwesomeOutlinedIcon /><div><Typography component="h3">Fundamental growth</Typography><Typography>{symbol} · EPS and revenue assessment</Typography></div></div>
      <div className="assessment-actions">
        {stale && <Chip size="small" color="warning" label="Stale" />}
        {scores?.provisional && <Chip size="small" variant="outlined" label="Provisional" />}
        <Button size="small" variant="contained" startIcon={active ? <CircularProgress size="0.85rem" color="inherit" /> : report ? <RefreshIcon /> : <AutoAwesomeOutlinedIcon />} onClick={() => void analyze()} disabled={state == null || !state.ai_enabled || active}>{active ? "Scoring…" : report == null ? "Analyze" : "Reassess"}</Button>
      </div>
    </div>
    {error && <Alert severity="error">{error}</Alert>}
    {job?.phase === "failed" && <Alert severity="error">{job.error} {report && "Your saved assessment is unchanged."}</Alert>}
    {state != null && !state.ai_enabled && <Alert severity="info">Configure AI to generate assessments. Saved assessments remain available.</Alert>}
    {state?.not_found_at && <Alert severity="info">Fundamentals returned HTTP 404. No assessment is available. Background checks resume after the configured refresh interval; you can retry manually.</Alert>}
    {state != null && !state.not_found_at && !state.data_ready && <Alert severity="info">Assessment will refresh fundamentals before analyzing.</Alert>}
    {stale && <Alert severity="warning">Financial data, company context, or assessment settings have changed. Reassess to update this score.</Alert>}
    {active && state?.job_stale && <Alert severity="warning">Inputs changed while AI is assessing the captured snapshot. The completed assessment will be marked stale.</Alert>}
    {(active || (job?.phase === "failed" && job.live_response)) && <section className="assessment-progress" aria-label="Assessment progress">
      <div className="assessment-progress-heading" role="status">{job?.phase === "failed" ? <InfoOutlinedIcon fontSize="small" /> : <CircularProgress size="0.9rem" />}<strong>{job ? phaseLabels[job.phase] : "Starting assessment"}</strong><span>{job?.background ? "Background · " : ""}{report ? "Saved assessment remains below" : stage === 0 ? "Loading the latest financial data" : "AI is reviewing the financial history"}</span></div>
      <ol className="assessment-stages">{["Refresh fundamentals", "AI assessment", "Saved"].map((label, index) => <li key={label} className={index < stage ? "is-complete" : index === stage ? "is-current" : ""}><span>{index + 1}</span>{label}</li>)}</ol>
      <AiOutputPreview content={job?.live_response ?? ""} status={job?.phase === "failed" ? "Interrupted" : job?.live_response ? "Writing assessment" : "Awaiting response"} expanded />
    </section>}
    {scores ? <>
      <div className="assessment-overview">
        <section className={`assessment-card assessment-score${stale ? " is-stale" : ""}`} aria-label="Overall growth score"><span className="assessment-eyebrow">Growth score</span><div className="assessment-score-number">{scores.total == null ? "—" : scores.total.toFixed(1)}<span>/ 100</span></div><Typography>{scores.total == null ? "Insufficient comparable history" : scores.provisional ? "Provisional · limited evidence" : "AI assessment of EPS and revenue"}</Typography></section>
        <section className="assessment-card assessment-profile"><span className="assessment-eyebrow">Assessment profile</span><Typography component="h4">{scores.profile === "profitable" ? "Profitable" : "Revenue-focused"}</Typography><Typography><AssessmentText text={scores.profile_reason} limit={300} /></Typography>{report && <Typography className="assessment-industry">{[...report.context.industries, ...report.context.themes].join(" · ")}</Typography>}<Chip size="small" variant="outlined" label={<AssessmentText text={scores.gaap_status} limit={160} />} /></section>
        <section className="assessment-card assessment-summary"><span className="assessment-eyebrow">Assessment</span><Typography><AssessmentText text={summary} /></Typography><div className="assessment-data-quality"><span>Data quality</span><Typography><AssessmentText text={scores.data_quality} limit={300} /></Typography></div></section>
      </div>
      <section className="assessment-panel" aria-label="Scoring breakdown"><div className="assessment-panel-heading"><FactCheckOutlinedIcon /><Typography component="h3">Scoring breakdown</Typography><span>AI-assigned scores · reported results first</span></div><ScoreTable scores={scores} summary={summary} lastUpdated={lastUpdated} /></section>
      {concerns.length > 0 && <section className="assessment-panel assessment-concerns"><div className="assessment-panel-heading"><InfoOutlinedIcon /><Typography component="h3">What to watch</Typography></div><ul>{concerns.map(concern => <li key={concern}><AssessmentText text={concern} limit={300} /></li>)}</ul></section>}
      <div className="assessment-footer"><span>Custom rubric informed by Minervini · {report?.model}</span><span>{report?.last_checked_at && <>Last checked <time dateTime={report.last_checked_at}>{new Date(report.last_checked_at).toLocaleString()}</time></>}</span><span>{snapshotAt && <>Financial data fetched <time dateTime={snapshotAt}>{new Date(snapshotAt).toLocaleString()}</time></>}</span></div>
    </> : !active && !state?.not_found_at && <div className="assessment-empty"><AutoAwesomeOutlinedIcon /><Typography component="h4">Understand the growth behind {symbol}</Typography><Typography>{state == null ? "Loading saved assessment…" : "Assess EPS and revenue strength, acceleration, and consistency."}</Typography><Typography>Analyze the current financial data to see criterion scores, supporting periods, and a short conclusion.</Typography></div>}
  </div>;
}

function AssessmentText({ text, limit = 400 }: { text: string; limit?: number }) {
  if (text.length <= limit) return <>{text}</>;
  const sentence = text.lastIndexOf(". ", limit - 1);
  const boundary = sentence >= limit / 2 ? sentence + 1 : text.lastIndexOf(" ", limit);
  const split = boundary > 0 ? boundary : limit;
  return <>{text.slice(0, split)}<span className="assessment-subtext">{text.slice(split)}</span></>;
}

function ScoreTable({ scores, summary, lastUpdated }: { scores: AssessmentScores; summary: string; lastUpdated: string }) {
  return <TableContainer className="assessment-table-container"><Table size="small" className="assessment-table" aria-label="Fundamental assessment scores">
    <TableHead><TableRow><TableCell>Criterion</TableCell><TableCell align="right">Score</TableCell><TableCell align="right">Maximum</TableCell><TableCell>Reason</TableCell><TableCell>Last updated</TableCell></TableRow></TableHead>
    <TableBody>{scores.rows.map(row => <TableRow key={row.id}>
      <TableCell className="assessment-criterion">{row.label}</TableCell>
      <TableCell align="right" className="assessment-row-score"><strong>{row.score == null ? "N/A" : row.score.toFixed(1)}</strong><LinearProgress variant="determinate" value={(row.score ?? 0) / row.maximum * 100} aria-label={`${row.label} score`} /></TableCell>
      <TableCell align="right" className="assessment-maximum">{row.maximum}</TableCell>
      <TableCell className="assessment-reason"><AssessmentText text={row.reason} /><div className="assessment-evidence">{row.evidence_ids.map(id => <span key={id}>{id}</span>)}</div></TableCell>
      <TableCell className="assessment-updated">{lastUpdated}</TableCell>
    </TableRow>)}<TableRow className="assessment-total"><TableCell>Final score{scores.provisional && <span>Provisional</span>}</TableCell><TableCell align="right">{scores.total == null ? "N/A" : scores.total.toFixed(1)}</TableCell><TableCell align="right">100</TableCell><TableCell><AssessmentText text={summary} /></TableCell><TableCell className="assessment-updated">{lastUpdated}</TableCell></TableRow></TableBody>
  </Table></TableContainer>;
}
