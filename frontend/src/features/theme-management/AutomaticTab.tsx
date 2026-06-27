import { type Dispatch, type SetStateAction, useEffect, useMemo, useState } from "react";
import { Button, Chip, TextField, Typography } from "@mui/material";
import {
  applyThemeAiJob,
  createAutomaticJobs,
  deleteThemeAiJob,
  fetchThemeAiJob,
  fetchThemeAiJobs,
  retryThemeAiJob,
  type AiCapability,
  type ThemeAiJob,
  type ThemeAiJobSummary,
  type ThemeTicker,
} from "../../api/themes";
import { TickerFilters, TickerSelectionHeader } from "./TickerListControls";
import { IndustryFilter } from "./IndustryFilter";
import { VirtualTickerList } from "./VirtualTickerList";
import {
  enrichTickers,
  errorMessage,
  type IndustryFilterOption,
  jobStatusColor,
  matchesIndustryFilter,
  sameData,
} from "./themeManagementUtils";

export function AutomaticTab({
  tickers,
  industries,
  selectedIndustryKeys,
  setSelectedIndustryKeys,
  capability,
  onChanged,
  onError,
  onMessage,
}: {
  tickers: ThemeTicker[];
  industries: IndustryFilterOption[];
  selectedIndustryKeys: Set<string>;
  setSelectedIndustryKeys: Dispatch<SetStateAction<Set<string> | undefined>>;
  capability: AiCapability;
  onChanged: () => void;
  onError: (message: string) => void;
  onMessage: (message: string) => void;
}) {
  const [search, setSearch] = useState("");
  const [unassignedOnly, setUnassignedOnly] = useState(true);
  const [unprocessedOnly, setUnprocessedOnly] = useState(true);
  const [selectedSymbols, setSelectedSymbols] = useState<Set<string>>(new Set());
  const [jobs, setJobs] = useState<ThemeAiJobSummary[]>([]);
  const [selectedJob, setSelectedJob] = useState<ThemeAiJob>();
  const [selectedId, setSelectedId] = useState<number>();
  const [showAppliedJobs, setShowAppliedJobs] = useState(false);
  const [busy, setBusy] = useState(false);
  const appliedJobCount = jobs.filter((job) => job.status === "applied").length;
  const visibleJobs = showAppliedJobs ? jobs : jobs.filter((job) => job.status !== "applied");
  const selectedSummary = jobs.find((job) => job.id === selectedId);
  const selected = selectedJob?.id === selectedSummary?.id ? selectedJob : undefined;
  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return tickers.filter(
      (ticker) =>
        (!unassignedOnly || ticker.assignments.length === 0) &&
        (!unprocessedOnly || !ticker.automatic_processed) &&
        matchesIndustryFilter(ticker, selectedIndustryKeys) &&
        (!query ||
          ticker.symbol.toLowerCase().includes(query) ||
          ticker.name?.toLowerCase().includes(query)),
    );
  }, [search, selectedIndustryKeys, tickers, unassignedOnly, unprocessedOnly]);

  useEffect(() => {
    const visible = new Set(filtered.map((ticker) => ticker.symbol));
    setSelectedSymbols((current) => {
      const next = new Set([...current].filter((symbol) => visible.has(symbol)));
      return next.size === current.size ? current : next;
    });
  }, [filtered]);

  useEffect(() => {
    if (!showAppliedJobs && selectedSummary?.status === "applied") {
      setSelectedId(undefined);
    }
  }, [selectedSummary?.status, showAppliedJobs]);

  const reloadJobs = async () => {
    const next = await fetchThemeAiJobs();
    setJobs((current) => (sameData(current, next) ? current : next));
  };
  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const next = await fetchThemeAiJobs();
        if (!active) return;
        setJobs((current) => (sameData(current, next) ? current : next));
      } catch (loadError) {
        if (active) onError(errorMessage(loadError));
      }
    };
    load();
    const interval = window.setInterval(load, 10_000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [onError]);

  useEffect(() => {
    if (selectedSummary === undefined) {
      setSelectedJob(undefined);
      return;
    }
    let active = true;
    fetchThemeAiJob(selectedSummary.id)
      .then((job) => {
        if (active) setSelectedJob(job);
      })
      .catch((loadError: unknown) => {
        if (active) onError(errorMessage(loadError));
      });
    return () => {
      active = false;
    };
  }, [onError, selectedSummary?.id, selectedSummary?.updated_at]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } catch (runError) {
      onError(errorMessage(runError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="theme-management-body automatic-layout">
      <aside className="theme-list-pane">
        <div className="ticker-search-row">
          <IndustryFilter
            industries={industries}
            selectedIndustryKeys={selectedIndustryKeys}
            setSelectedIndustryKeys={setSelectedIndustryKeys}
          />
          <TextField
            size="small"
            placeholder="Search tickers"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <TickerFilters
            unprocessedOnly={unprocessedOnly}
            setUnprocessedOnly={setUnprocessedOnly}
            unassignedOnly={unassignedOnly}
            setUnassignedOnly={setUnassignedOnly}
          />
        </div>
        <TickerSelectionHeader
          selectedCount={selectedSymbols.size}
          visibleCount={filtered.length}
          onChange={(selectAll) => {
            if (!selectAll) {
              setSelectedSymbols(new Set());
              return;
            }
            const symbols = filtered.map((ticker) => ticker.symbol);
            enrichTickers(symbols.filter((symbol) => !selectedSymbols.has(symbol)), onError);
            setSelectedSymbols(new Set(symbols));
          }}
        />
        <VirtualTickerList
          tickers={filtered}
          selectedSymbols={selectedSymbols}
          onToggle={(symbol) => {
            if (!selectedSymbols.has(symbol)) enrichTickers([symbol], onError);
            setSelectedSymbols((current) => {
              const next = new Set(current);
              next.has(symbol) ? next.delete(symbol) : next.add(symbol);
              return next;
            });
          }}
        />
      </aside>
      <main className="automatic-workspace">
        <section className="assignment-card automatic-schedule-card">
          <div className="bulk-assignment-heading">
            <Typography component="h2">Automatic Assignment</Typography>
            <div className="bulk-actions">
              <Chip label={`${selectedSymbols.size} selected`} />
              <Button
                variant="contained"
                disabled={busy || selectedSymbols.size === 0 || !capability.enabled}
                title={capability.enabled ? undefined : "Configure [ai] to enable automatic assignment"}
                onClick={() =>
                  run(async () => {
                    const jobs = await createAutomaticJobs([...selectedSymbols]);
                    setSelectedSymbols(new Set());
                    setSelectedId(jobs.ids[0]);
                    await reloadJobs();
                    onMessage(`${jobs.ids.length} automatic AI jobs scheduled`);
                  })
                }
              >
                Schedule {capability.model ?? "Automatic AI"}
              </Button>
            </div>
          </div>
          <Typography color="text.secondary">
            Selected tickers will be split into batches of {capability.batch_size ?? "configured"}.
          </Typography>
        </section>
        <section className="automatic-job-review">
          <aside className="automatic-job-list">
            <div className="theme-pane-header">
              <Typography component="h2">Jobs ({visibleJobs.length})</Typography>
              {appliedJobCount > 0 && (
                <Button size="small" onClick={() => setShowAppliedJobs((current) => !current)}>
                  {showAppliedJobs ? "Hide Applied" : `Show Applied (${appliedJobCount})`}
                </Button>
              )}
            </div>
            <ol className="theme-management-list">
              {visibleJobs.map((job) => (
                <li key={job.id}>
                  <button
                    className="theme-management-list-item"
                    aria-pressed={job.id === selectedSummary?.id}
                    onClick={() => setSelectedId(job.id)}
                  >
                    <span>
                      <strong>{job.symbol_count} tickers · {job.model}</strong>
                      <small>{new Date(job.updated_at).toLocaleString()}</small>
                    </span>
                    <Chip
                      size="small"
                      label={job.status.replace("_", " ")}
                      color={jobStatusColor(job.status)}
                    />
                  </button>
                </li>
              ))}
            </ol>
          </aside>
          <div className="automatic-job-detail">
            {selected === undefined ? (
              <section className="assignment-card">
                <Typography component="h2">Select an automatic job</Typography>
              </section>
            ) : (
              <section className="assignment-card">
                <div className="bulk-assignment-heading">
                  <Typography component="h2">Job #{selected.id}</Typography>
                  <div className="bulk-actions">
                    <Chip
                      label={selected.status.replace("_", " ")}
                      color={jobStatusColor(selected.status)}
                    />
                    {["completed", "partially_failed"].includes(selected.status) && (
                      <Button
                        variant="contained"
                        disabled={busy}
                        onClick={() =>
                          run(async () => {
                            await applyThemeAiJob(selected.id);
                            await reloadJobs();
                            onChanged();
                            onMessage("AI job assignments applied");
                          })
                        }
                      >
                        {selected.status === "partially_failed" ? "Apply Valid" : "Apply"}
                      </Button>
                    )}
                    {selected.status === "failed" && (
                      <Button
                        variant="contained"
                        disabled={busy || !capability.enabled}
                        onClick={() =>
                          run(async () => {
                            const jobs = await retryThemeAiJob(selected.id);
                            setSelectedId(jobs.ids[0]);
                            await reloadJobs();
                            onMessage(
                              `${jobs.ids.length} retry job${jobs.ids.length === 1 ? "" : "s"} scheduled`,
                            );
                          })
                        }
                      >
                        Retry
                      </Button>
                    )}
                    {!["pending", "running"].includes(selected.status) && (
                      <Button
                        color="error"
                        disabled={busy}
                        onClick={() =>
                          run(async () => {
                            await deleteThemeAiJob(selected.id);
                            setSelectedId(undefined);
                            await reloadJobs();
                            onMessage("AI job discarded");
                          })
                        }
                      >
                        Discard
                      </Button>
                    )}
                  </div>
                </div>
                <Typography color="text.secondary">{selected.symbols.join(", ")}</Typography>
                {selected.retry_of_job_id !== null && (
                  <Typography color="text.secondary">
                    Retry of job #{selected.retry_of_job_id}
                  </Typography>
                )}
                {selected.error && <Typography color="error">{selected.error}</Typography>}
                {selected.suggestions !== null && selected.suggestions.length > 0 && (
                  <div className="suggestion-preview ai-job-suggestions">
                    {selected.suggestions.map((suggestion) => (
                      <div key={suggestion.symbol} className="suggestion-row">
                        <strong>{suggestion.symbol}</strong>
                        <span>{suggestion.themes.length > 0 ? suggestion.themes.join(", ") : "No theme"}</span>
                        <small>{suggestion.reasoning}</small>
                      </div>
                    ))}
                  </div>
                )}
                {selected.validation_errors.length > 0 && (
                  <div className="suggestion-preview ai-job-errors">
                    {selected.validation_errors.map((validationError, index) => (
                      <div
                        key={`${validationError.symbol ?? "unknown"}-${index}`}
                        className="suggestion-row suggestion-error-row"
                      >
                        <strong>{validationError.symbol ?? "Unknown ticker"}</strong>
                        <span>{validationError.error}</span>
                      </div>
                    ))}
                  </div>
                )}
                {selected.response && (
                  <TextField
                    multiline
                    minRows={8}
                    label="Raw response"
                    value={selected.response}
                    slotProps={{ input: { readOnly: true } }}
                  />
                )}
              </section>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}
