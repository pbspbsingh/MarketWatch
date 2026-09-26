import { type Dispatch, type SetStateAction, useCallback, useEffect, useMemo, useState } from "react";
import DeleteSweepIcon from "@mui/icons-material/DeleteSweep";
import VisibilityIcon from "@mui/icons-material/Visibility";
import VisibilityOffIcon from "@mui/icons-material/VisibilityOff";
import { Button, Chip, IconButton, TextField, Tooltip, Typography } from "@mui/material";
import {
  applyThemeAiJob,
  createAutomaticJobs,
  deleteAppliedThemeAiJobs,
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
  filterThemeTickers,
  type IndustryFilterOption,
  jobStatusColor,
  sameData,
} from "./themeManagementUtils";

export function AutomaticTab({
  refreshKey,
  tickers,
  industries,
  selectedIndustryKeys,
  setSelectedIndustryKeys,
  unassignedOnly,
  setUnassignedOnly,
  unprocessedOnly,
  setUnprocessedOnly,
  capability,
  onChanged,
  onError,
  onMessage,
}: {
  refreshKey: string;
  tickers: ThemeTicker[];
  industries: IndustryFilterOption[];
  selectedIndustryKeys: Set<string>;
  setSelectedIndustryKeys: Dispatch<SetStateAction<Set<string> | undefined>>;
  unassignedOnly: boolean;
  setUnassignedOnly: Dispatch<SetStateAction<boolean>>;
  unprocessedOnly: boolean;
  setUnprocessedOnly: Dispatch<SetStateAction<boolean>>;
  capability: AiCapability;
  onChanged: () => void;
  onError: (message: string) => void;
  onMessage: (message: string) => void;
}) {
  const [search, setSearch] = useState("");
  const [selectedSymbols, setSelectedSymbols] = useState<Set<string>>(new Set());
  const [jobs, setJobs] = useState<ThemeAiJobSummary[]>([]);
  const [selectedJob, setSelectedJob] = useState<ThemeAiJob>();
  const [selectedId, setSelectedId] = useState<number>();
  const [showAppliedJobs, setShowAppliedJobs] = useState(false);
  const [busy, setBusy] = useState(false);
  const hasActiveJobs = jobs.some((job) => job.status === "pending" || job.status === "running");
  const appliedJobCount = jobs.filter((job) => job.status === "applied").length;
  const visibleJobs = showAppliedJobs ? jobs : jobs.filter((job) => job.status !== "applied");
  const selectedSummary = jobs.find((job) => job.id === selectedId);
  const selected = selectedJob?.id === selectedSummary?.id ? selectedJob : undefined;
  const selectedJobId = selectedSummary?.id;
  const selectedJobUpdatedAt = selectedSummary?.updated_at;
  const selectedJobIsActive =
    selectedSummary?.status === "pending" || selectedSummary?.status === "running";
  const filtered = useMemo(
    () => filterThemeTickers(tickers, search, selectedIndustryKeys, unassignedOnly, unprocessedOnly),
    [search, selectedIndustryKeys, tickers, unassignedOnly, unprocessedOnly],
  );

  const reloadJobs = useCallback(async (signal?: AbortSignal) => {
    const next = await fetchThemeAiJobs(signal);
    if (!signal?.aborted) setJobs((current) => (sameData(current, next) ? current : next));
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void fetchThemeAiJobs(controller.signal)
      .then((next) => {
        if (!controller.signal.aborted) {
          setJobs((current) => (sameData(current, next) ? current : next));
        }
      })
      .catch((loadError: unknown) => {
        if (!controller.signal.aborted) onError(errorMessage(loadError));
      });
    return () => controller.abort();
  }, [onError, refreshKey, reloadJobs]);

  useEffect(() => {
    if (!hasActiveJobs || document.visibilityState !== "visible") return;
    const controller = new AbortController();
    let timeout: number | undefined;
    const poll = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        await reloadJobs(controller.signal);
      } catch (loadError) {
        if (!controller.signal.aborted) onError(errorMessage(loadError));
      }
      if (!controller.signal.aborted && document.visibilityState === "visible") {
        timeout = window.setTimeout(poll, 10_000);
      }
    };
    timeout = window.setTimeout(poll, 10_000);
    return () => {
      controller.abort();
      if (timeout !== undefined) window.clearTimeout(timeout);
    };
  }, [hasActiveJobs, onError, refreshKey, reloadJobs]);

  useEffect(() => {
    if (selectedJobId === undefined || document.visibilityState !== "visible") return;
    const controller = new AbortController();
    let timeout: number | undefined;
    let errorReported = false;
    const load = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const job = await fetchThemeAiJob(selectedJobId, controller.signal);
        if (controller.signal.aborted) return;
        setSelectedJob(job);
        errorReported = false;
        if ((job.status === "pending" || job.status === "running")
          && document.visibilityState === "visible") {
          timeout = window.setTimeout(load, 2_500);
        } else if (selectedJobIsActive && document.visibilityState === "visible") {
          void reloadJobs(controller.signal).catch((loadError: unknown) => {
            if (!controller.signal.aborted) onError(errorMessage(loadError));
          });
        }
      } catch (loadError) {
        if (controller.signal.aborted) return;
        if (!errorReported) {
          onError(errorMessage(loadError));
          errorReported = true;
        }
        if (selectedJobIsActive && document.visibilityState === "visible") {
          timeout = window.setTimeout(load, 2_500);
        }
      }
    };
    void load();
    return () => {
      controller.abort();
      if (timeout !== undefined) window.clearTimeout(timeout);
    };
  }, [onError, refreshKey, reloadJobs, selectedJobId, selectedJobIsActive, selectedJobUpdatedAt]);

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
            setSelectedIndustryKeys={(update) => {
              setSelectedSymbols(new Set());
              setSelectedIndustryKeys(update);
            }}
          />
          <TextField
            size="small"
            placeholder="Search tickers"
            value={search}
            onChange={(event) => {
              setSelectedSymbols(new Set());
              setSearch(event.target.value);
            }}
          />
          <TickerFilters
            unprocessedOnly={unprocessedOnly}
            setUnprocessedOnly={(update) => {
              setSelectedSymbols(new Set());
              setUnprocessedOnly(update);
            }}
            unassignedOnly={unassignedOnly}
            setUnassignedOnly={(update) => {
              setSelectedSymbols(new Set());
              setUnassignedOnly(update);
            }}
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
            enrichTickers(symbols.filter((symbol) => !selectedSymbols.has(symbol)), onError, onChanged);
            setSelectedSymbols(new Set(symbols));
          }}
        />
        <VirtualTickerList
          tickers={filtered}
          search={search}
          selectedSymbols={selectedSymbols}
          onToggle={(symbol) => {
            if (!selectedSymbols.has(symbol)) enrichTickers([symbol], onError, onChanged);
            setSelectedSymbols((current) => {
              const next = new Set(current);
              if (next.has(symbol)) next.delete(symbol);
              else next.add(symbol);
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
            <div className="theme-pane-header automatic-job-header">
              <Typography component="h2">Jobs ({visibleJobs.length})</Typography>
              {appliedJobCount > 0 && (
                <div className="bulk-actions">
                  <Tooltip title={`${showAppliedJobs ? "Hide" : "Show"} ${appliedJobCount} applied jobs`}>
                    <IconButton
                      size="small"
                      aria-label={`${showAppliedJobs ? "Hide" : "Show"} applied jobs`}
                      onClick={() => {
                        if (showAppliedJobs && selectedSummary?.status === "applied") {
                          setSelectedId(undefined);
                        }
                        setShowAppliedJobs((current) => !current);
                      }}
                    >
                      {showAppliedJobs ? (
                        <VisibilityOffIcon fontSize="small" />
                      ) : (
                        <VisibilityIcon fontSize="small" />
                      )}
                    </IconButton>
                  </Tooltip>
                  <Tooltip title={`Delete ${appliedJobCount} applied job records`}>
                    <span>
                      <IconButton
                        size="small"
                        color="error"
                        disabled={busy}
                        aria-label="Delete all applied jobs"
                        onClick={() => {
                          if (!window.confirm(`Delete ${appliedJobCount} applied job records?`)) return;
                          void run(async () => {
                            const result = await deleteAppliedThemeAiJobs();
                            if (selectedSummary?.status === "applied") setSelectedId(undefined);
                            setShowAppliedJobs(false);
                            await reloadJobs();
                            onMessage(`${result.deleted_count} applied job records deleted`);
                          });
                        }}
                      >
                        <DeleteSweepIcon fontSize="small" />
                      </IconButton>
                    </span>
                  </Tooltip>
                </div>
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
              <section className="assignment-card automatic-job-card">
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
                            const job = await retryThemeAiJob(selected.id);
                            setSelectedId(job.id);
                            await reloadJobs();
                            onMessage("AI job retry started");
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
                <div className="automatic-job-content">
                  <Typography color="text.secondary">{selected.symbols.join(", ")}</Typography>
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
                  {selected.reasoning && (
                    <TextField
                      className="ai-job-stream"
                      multiline
                      label="Live reasoning"
                      value={selected.reasoning}
                      slotProps={{ input: { readOnly: true } }}
                    />
                  )}
                  {selected.response && (
                    <TextField
                      className="ai-job-stream"
                      multiline
                      label={selected.status === "running" ? "Live response" : "Raw response"}
                      value={selected.response}
                      slotProps={{ input: { readOnly: true } }}
                    />
                  )}
                </div>
              </section>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}
