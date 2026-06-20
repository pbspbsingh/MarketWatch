import { type Dispatch, type SetStateAction, useEffect, useMemo, useState } from "react";
import AddIcon from "@mui/icons-material/Add";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import {
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  IconButton,
  Menu,
  MenuItem,
  Tab,
  Tabs,
  TextField,
  Typography,
} from "@mui/material";
import {
  applyThemeSuggestions,
  applyThemeAiJob,
  addThemeTicker,
  createAutomaticJobs,
  createTheme,
  deleteThemeAiJob,
  deleteTheme,
  deleteThemeTicker,
  fetchAiCapability,
  fetchThemeAiJob,
  fetchThemeAiJobs,
  fetchThemeIndustries,
  fetchThemes,
  fetchThemeTickers,
  generateThemePrompt,
  parseThemeSuggestions,
  replaceTickerThemes,
  updateTheme,
  type AiCapability,
  type Theme,
  type ThemeAiJob,
  type ThemeAiJobSummary,
  type ThemeSuggestion,
  type ThemeTicker,
  type ThemeTickerIndustry,
} from "../../api/themes";
import { Toast } from "../../components/Toast";

const unclassifiedIndustryKey = "__unclassified__";

type IndustryFilterOption = ThemeTickerIndustry;

function industryFilterOptions(
  industries: ThemeTickerIndustry[],
  tickers: ThemeTicker[],
): IndustryFilterOption[] {
  const options = new Map(industries.map((industry) => [industry.key, industry.name]));
  let hasUnclassified = false;
  for (const ticker of tickers) {
    if (ticker.industries.length === 0) hasUnclassified = true;
    for (const industry of ticker.industries) options.set(industry.key, industry.name);
  }
  if (hasUnclassified) options.set(unclassifiedIndustryKey, "No industry");
  return [...options]
    .map(([key, name]) => ({ key, name }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function matchesIndustryFilter(ticker: ThemeTicker, selectedIndustryKeys: Set<string>) {
  return ticker.industries.length === 0
    ? selectedIndustryKeys.has(unclassifiedIndustryKey)
    : ticker.industries.some((industry) => selectedIndustryKeys.has(industry.key));
}

function enrichTickers(symbols: string[], onError: (message: string) => void) {
  if (symbols.length === 0) return;
  void Promise.all(symbols.map(addThemeTicker)).catch((error: unknown) =>
    onError(errorMessage(error)),
  );
}

export function ThemeManagementPage() {
  const [tab, setTab] = useState(0);
  const [themes, setThemes] = useState<Theme[]>([]);
  const [tickers, setTickers] = useState<ThemeTicker[]>([]);
  const [themeIndustries, setThemeIndustries] = useState<ThemeTickerIndustry[]>([]);
  const [capability, setCapability] = useState<AiCapability>({
    enabled: false,
    model: null,
    batch_size: null,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<string>();
  const industries = useMemo(
    () => industryFilterOptions(themeIndustries, tickers),
    [themeIndustries, tickers],
  );
  const [selectedIndustryKeys, setSelectedIndustryKeys] = useState<Set<string>>();

  useEffect(() => {
    if (industries.length === 0) return;
    setSelectedIndustryKeys((current) => current ?? new Set(industries.map((industry) => industry.key)));
  }, [industries]);

  const selectedIndustries =
    selectedIndustryKeys ?? new Set(industries.map((industry) => industry.key));

  const reload = async () => {
    const [nextThemes, nextTickers, nextIndustries, nextCapability] = await Promise.all([
      fetchThemes(),
      fetchThemeTickers(),
      fetchThemeIndustries(),
      fetchAiCapability(),
    ]);
    setThemes(nextThemes);
    setTickers(nextTickers);
    setThemeIndustries(nextIndustries);
    setCapability(nextCapability);
  };

  useEffect(() => {
    let active = true;
    const refresh = () =>
      reload().catch((loadError: unknown) => {
        if (active) setError(errorMessage(loadError));
      });

    reload()
      .catch((loadError: unknown) => setError(errorMessage(loadError)))
      .finally(() => setLoading(false));
    const interval = window.setInterval(refresh, 10_000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, []);

  if (loading) {
    return (
      <div className="panel-status">
        <CircularProgress size="1rem" />
        <Typography color="text.secondary">Loading themes</Typography>
      </div>
    );
  }

  return (
    <section className="theme-management-page">
      <header className="theme-management-header">
        <Typography component="h1">Theme Management</Typography>
        <Tabs value={tab} onChange={(_, value: number) => setTab(value)}>
          <Tab label="Ticker Assignments" />
          <Tab label="Automatic" />
          <Tab label="Themes" />
        </Tabs>
      </header>
      {tab === 0 ? (
        <AssignmentsTab
          themes={themes}
          tickers={tickers}
          industries={industries}
          selectedIndustryKeys={selectedIndustries}
          setSelectedIndustryKeys={setSelectedIndustryKeys}
          onChanged={() => reload().catch((changeError: unknown) => setError(errorMessage(changeError)))}
          onError={setError}
          onMessage={setMessage}
        />
      ) : tab === 1 ? (
        <AutomaticTab
          tickers={tickers}
          industries={industries}
          selectedIndustryKeys={selectedIndustries}
          setSelectedIndustryKeys={setSelectedIndustryKeys}
          capability={capability}
          onChanged={() => reload().catch((changeError: unknown) => setError(errorMessage(changeError)))}
          onError={setError}
          onMessage={setMessage}
        />
      ) : (
        <ThemesTab
          themes={themes}
          onChanged={() => reload().catch((changeError: unknown) => setError(errorMessage(changeError)))}
          onError={setError}
          onMessage={setMessage}
        />
      )}
      <Toast message={error} onClose={() => setError(undefined)} />
      <Toast message={message} severity="success" onClose={() => setMessage(undefined)} />
    </section>
  );
}

function ThemesTab({
  themes,
  onChanged,
  onError,
  onMessage,
}: {
  themes: Theme[];
  onChanged: () => void;
  onError: (message: string) => void;
  onMessage: (message: string) => void;
}) {
  const [selectedId, setSelectedId] = useState<number>();
  const selected = themes.find((theme) => theme.id === selectedId);
  const [draft, setDraft] = useState({ name: "", etf_symbol: "", description: "" });

  useEffect(() => {
    setDraft({
      name: selected?.name ?? "",
      etf_symbol: selected?.etf_symbol ?? "",
      description: selected?.description ?? "",
    });
  }, [selected]);

  const save = async () => {
    try {
      const input = { ...draft, description: draft.description || null };
      if (selected === undefined) {
        const created = await createTheme(input);
        setSelectedId(created.id);
      } else {
        await updateTheme(selected.id, input);
      }
      onMessage(selected === undefined ? "Theme created" : "Theme updated");
      onChanged();
    } catch (saveError) {
      onError(errorMessage(saveError));
    }
  };

  const remove = async () => {
    if (selected === undefined) return;
    if (!window.confirm(`Delete ${selected.name} and its ${selected.stock_count} assignments?`)) return;
    try {
      await deleteTheme(selected.id);
      setSelectedId(undefined);
      onMessage("Theme deleted");
      onChanged();
    } catch (deleteError) {
      onError(errorMessage(deleteError));
    }
  };

  return (
    <div className="theme-management-body">
      <aside className="theme-list-pane">
        <div className="theme-pane-header">
          <Typography component="h2">Themes ({themes.length})</Typography>
          <IconButton
            size="small"
            aria-label="Add theme"
            onClick={() => {
              setSelectedId(undefined);
              setDraft({ name: "", etf_symbol: "", description: "" });
            }}
          >
            <AddIcon fontSize="small" />
          </IconButton>
        </div>
        <ol className="theme-management-list">
          {themes.map((theme) => (
            <li key={theme.id}>
              <button
                className="theme-management-list-item"
                aria-pressed={theme.id === selectedId}
                onClick={() => setSelectedId(theme.id)}
              >
                <span>
                  <strong>{theme.name}</strong>
                  <small>{theme.etf_symbol}</small>
                </span>
                <Chip size="small" label={theme.stock_count} />
              </button>
            </li>
          ))}
        </ol>
      </aside>
      <main className="theme-editor-pane">
        <div className="theme-editor-heading">
          <Typography component="h2">{selected === undefined ? "Add Theme" : "Edit Theme"}</Typography>
          {selected !== undefined && (
            <IconButton size="small" color="error" aria-label="Delete theme" onClick={remove}>
              <DeleteOutlineIcon fontSize="small" />
            </IconButton>
          )}
        </div>
        <TextField
          label="Name"
          value={draft.name}
          onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
        />
        <TextField
          label="ETF"
          value={draft.etf_symbol}
          onChange={(event) =>
            setDraft((current) => ({ ...current, etf_symbol: event.target.value.toUpperCase() }))
          }
        />
        <TextField
          multiline
          minRows={4}
          label="Description"
          value={draft.description}
          onChange={(event) =>
            setDraft((current) => ({ ...current, description: event.target.value }))
          }
        />
        <Button variant="contained" disabled={!draft.name.trim() || !draft.etf_symbol.trim()} onClick={save}>
          {selected === undefined ? "Create Theme" : "Save Changes"}
        </Button>
      </main>
    </div>
  );
}

function AssignmentsTab({
  themes,
  tickers,
  industries,
  selectedIndustryKeys,
  setSelectedIndustryKeys,
  onChanged,
  onError,
  onMessage,
}: {
  themes: Theme[];
  tickers: ThemeTicker[];
  industries: IndustryFilterOption[];
  selectedIndustryKeys: Set<string>;
  setSelectedIndustryKeys: Dispatch<SetStateAction<Set<string> | undefined>>;
  onChanged: () => void;
  onError: (message: string) => void;
  onMessage: (message: string) => void;
}) {
  const [search, setSearch] = useState("");
  const [newSymbol, setNewSymbol] = useState("");
  const [unassignedOnly, setUnassignedOnly] = useState(false);
  const [selectedSymbol, setSelectedSymbol] = useState<string>();
  const [batchSymbols, setBatchSymbols] = useState<Set<string>>(new Set());
  const [draftThemeIds, setDraftThemeIds] = useState<number[]>([]);
  const [prompt, setPrompt] = useState("");
  const [response, setResponse] = useState("");
  const [suggestions, setSuggestions] = useState<ThemeSuggestion[]>([]);
  const [busy, setBusy] = useState(false);
  const [promptLoading, setPromptLoading] = useState(false);
  const selectedTicker = tickers.find((ticker) => ticker.symbol === selectedSymbol);
  const batchTicker =
    batchSymbols.size === 1
      ? tickers.find((ticker) => batchSymbols.has(ticker.symbol))
      : undefined;
  const editedTicker = batchSymbols.size === 0 ? selectedTicker : batchTicker;
  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return tickers.filter(
      (ticker) =>
        (!unassignedOnly || ticker.assignments.length === 0) &&
        matchesIndustryFilter(ticker, selectedIndustryKeys) &&
        (!query ||
          ticker.symbol.toLowerCase().includes(query) ||
          ticker.name?.toLowerCase().includes(query)),
    );
  }, [search, selectedIndustryKeys, tickers, unassignedOnly]);
  const promptFingerprint = useMemo(
    () =>
      JSON.stringify({
        themes: themes.map(({ name, description }) => ({ name, description })),
        tickers: tickers
          .filter((ticker) => batchSymbols.has(ticker.symbol))
          .map(({ symbol, name, description }) => ({ symbol, name, description })),
      }),
    [batchSymbols, themes, tickers],
  );

  useEffect(() => {
    const visible = new Set(filtered.map((ticker) => ticker.symbol));
    setBatchSymbols((current) => {
      const next = new Set([...current].filter((symbol) => visible.has(symbol)));
      return next.size === current.size ? current : next;
    });
  }, [filtered]);

  useEffect(() => {
    setDraftThemeIds(editedTicker?.assignments.map((assignment) => assignment.theme_id) ?? []);
  }, [editedTicker]);

  useEffect(() => {
    setPrompt("");
    setResponse("");
    setSuggestions([]);
  }, [batchSymbols]);

  useEffect(() => {
    if (batchSymbols.size < 2) return;

    let active = true;
    setPromptLoading(true);
    generateThemePrompt([...batchSymbols])
      .then((result) => {
        if (active) {
          setPrompt((current) => {
            if (current === result.prompt) return current;
            setResponse("");
            setSuggestions([]);
            return result.prompt;
          });
        }
      })
      .catch((promptError: unknown) => {
        if (active) onError(errorMessage(promptError));
      })
      .finally(() => {
        if (active) setPromptLoading(false);
      });
    return () => {
      active = false;
    };
  }, [batchSymbols, onError, promptFingerprint]);

  const toggleTheme = (id: number) => {
    if (!draftThemeIds.includes(id) && draftThemeIds.length >= 2) {
      onError("A ticker may have at most two themes");
      return;
    }
    setDraftThemeIds((current) =>
      current.includes(id)
        ? current.filter((themeId) => themeId !== id)
        : [...current, id],
    );
  };

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

  const removeTicker = (ticker: ThemeTicker) => {
    if (
      !window.confirm(
        `Permanently delete ${ticker.symbol} and its market data, industry memberships, theme assignments, and related AI jobs?`,
      )
    ) {
      return;
    }
    void run(async () => {
      await deleteThemeTicker(ticker.symbol);
      setBatchSymbols(new Set());
      setSelectedSymbol(undefined);
      onMessage(`${ticker.symbol} deleted`);
      onChanged();
    });
  };

  return (
    <div className="theme-management-body assignment-layout">
      <aside className="theme-list-pane">
        <div className="ticker-search-row">
          <TextField
            size="small"
            placeholder="Search tickers"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <TextField
            size="small"
            placeholder="Add symbol"
            value={newSymbol}
            onChange={(event) => setNewSymbol(event.target.value.toUpperCase())}
            onKeyDown={(event) => {
              if (event.key === "Enter" && newSymbol.trim()) {
                run(async () => {
                  await addThemeTicker(newSymbol);
                  setBatchSymbols(new Set());
                  setSelectedSymbol(newSymbol.trim().toUpperCase());
                  setNewSymbol("");
                  onMessage("Ticker added with Yahoo profile and Finviz industry");
                  onChanged();
                });
              }
            }}
          />
          <IconButton
            size="small"
            aria-label="Add ticker"
            disabled={busy || !newSymbol.trim()}
            onClick={() =>
              run(async () => {
                await addThemeTicker(newSymbol);
                setBatchSymbols(new Set());
                setSelectedSymbol(newSymbol.trim().toUpperCase());
                setNewSymbol("");
                onMessage("Ticker added with Yahoo profile and Finviz industry");
                onChanged();
              })
            }
          >
            <AddIcon fontSize="small" />
          </IconButton>
        </div>
        <div className="ticker-selection-controls">
          <IndustryFilter
            industries={industries}
            selectedIndustryKeys={selectedIndustryKeys}
            setSelectedIndustryKeys={setSelectedIndustryKeys}
          />
          <Button
            size="small"
            variant={unassignedOnly ? "contained" : "text"}
            onClick={() => setUnassignedOnly((current) => !current)}
          >
            Unassigned
          </Button>
          <Button
            size="small"
            disabled={filtered.length === 0}
            onClick={() => {
              const symbols = filtered.map((ticker) => ticker.symbol);
              enrichTickers(symbols.filter((symbol) => !batchSymbols.has(symbol)), onError);
              setBatchSymbols(new Set(symbols));
            }}
          >
            Select all
          </Button>
          <Button
            size="small"
            disabled={batchSymbols.size === 0}
            onClick={() => setBatchSymbols(new Set())}
          >
            Select none
          </Button>
        </div>
        <ol className="theme-management-list">
          {filtered.map((ticker) => (
            <li key={ticker.symbol}>
              <div className="ticker-assignment-row">
                <Checkbox
                  size="small"
                  checked={batchSymbols.has(ticker.symbol)}
                  onChange={() => {
                    if (!batchSymbols.has(ticker.symbol)) {
                      enrichTickers([ticker.symbol], onError);
                    }
                    setBatchSymbols((current) => {
                      const next = new Set(current);
                      next.has(ticker.symbol) ? next.delete(ticker.symbol) : next.add(ticker.symbol);
                      return next;
                    });
                  }}
                />
                <button
                  className="theme-management-list-item"
                  aria-pressed={ticker.symbol === editedTicker?.symbol}
                  onClick={() => {
                    setBatchSymbols(new Set());
                    setSelectedSymbol(ticker.symbol);
                  }}
                >
                  <span>
                    <strong>{ticker.symbol}</strong>
                    <small>{ticker.name ?? "Unknown company"}</small>
                  </span>
                  <Chip size="small" label={ticker.assignments.length} />
                </button>
              </div>
            </li>
          ))}
        </ol>
      </aside>
      <main className="assignment-workspace">
        {editedTicker !== undefined && (
          <section className="assignment-card ticker-theme-editor">
            <div className="ticker-profile">
              <Typography component="h2">
                {editedTicker.symbol}
                {editedTicker.name ? ` · ${editedTicker.name}` : ""}
              </Typography>
              <Typography color="text.secondary">
                {editedTicker.description ?? "No company description available."}
              </Typography>
            </div>
            <Typography color="text.secondary">
              Prefer one theme. Select a second only for a distinct, material business driver.
            </Typography>
            <div className="theme-chip-grid">
              {themes.map((theme) => (
                <Chip
                  key={theme.id}
                  clickable
                  color={draftThemeIds.includes(theme.id) ? "primary" : "default"}
                  label={`${theme.name} · ${theme.etf_symbol}`}
                  onClick={() => toggleTheme(theme.id)}
                />
              ))}
            </div>
            <Button
              variant="contained"
              onClick={() =>
                run(async () => {
                  await replaceTickerThemes(editedTicker.symbol, draftThemeIds);
                  onMessage("Ticker themes updated");
                  onChanged();
                })
              }
            >
              Save Manual Assignment
            </Button>
            <Button color="error" disabled={busy} onClick={() => removeTicker(editedTicker)}>
              Delete Ticker
            </Button>
          </section>
        )}
        {batchSymbols.size > 1 && (
          <section className="assignment-card bulk-assignment-card">
            <div className="bulk-assignment-heading">
              <Typography component="h2">Bulk Manual Assignment</Typography>
              <Chip label={`${batchSymbols.size} selected`} />
            </div>
            <div className="bulk-manual-workspace">
              <div className="bulk-manual-pane bulk-prompt-pane">
                <TextField
                  multiline
                  label={promptLoading ? "Preparing prompt..." : "Prompt"}
                  value={prompt}
                  InputProps={{ readOnly: true }}
                />
                <Button
                  disabled={promptLoading || !prompt}
                  onClick={async () => {
                    await navigator.clipboard.writeText(prompt);
                    onMessage("Prompt copied");
                  }}
                >
                  Copy Prompt
                </Button>
              </div>
              <div className="bulk-manual-pane bulk-response-pane">
                <TextField
                  multiline
                  label="Paste AI JSON response"
                  value={response}
                  onChange={(event) => setResponse(event.target.value)}
                />
                <Button
                  disabled={busy || !response.trim()}
                  onClick={() =>
                    run(async () => {
                      setSuggestions(await parseThemeSuggestions(response));
                    })
                  }
                >
                  Validate Response
                </Button>
                {suggestions.length > 0 && (
                  <div className="suggestion-preview">
                    <Typography component="h3">Preview</Typography>
                    <div className="suggestion-list">
                      {suggestions.map((suggestion) => (
                        <div key={suggestion.symbol} className="suggestion-row">
                          <strong>{suggestion.symbol}</strong>
                          <span>{suggestion.themes.length > 0 ? suggestion.themes.join(", ") : "No theme"}</span>
                          <small>{suggestion.reasoning}</small>
                        </div>
                      ))}
                    </div>
                    <Button
                      variant="contained"
                      disabled={busy}
                      onClick={() =>
                        run(async () => {
                          await applyThemeSuggestions(suggestions, "manual_ai");
                          setSuggestions([]);
                          onMessage("Bulk assignments applied");
                          onChanged();
                        })
                      }
                    >
                      Apply Preview
                    </Button>
                  </div>
                )}
              </div>
            </div>
          </section>
        )}
        {editedTicker === undefined && batchSymbols.size < 2 && (
          <section className="assignment-card assignment-empty-state">
            <Typography component="h2">Select a ticker</Typography>
            <Typography color="text.secondary">
              Select one ticker to edit its themes, or check multiple tickers for bulk assignment.
            </Typography>
          </section>
        )}
      </main>
    </div>
  );
}

function IndustryFilter({
  industries,
  selectedIndustryKeys,
  setSelectedIndustryKeys,
}: {
  industries: IndustryFilterOption[];
  selectedIndustryKeys: Set<string>;
  setSelectedIndustryKeys: Dispatch<SetStateAction<Set<string> | undefined>>;
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const allSelected = selectedIndustryKeys.size === industries.length;

  const toggleIndustry = (key: string) => {
    setSelectedIndustryKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <>
      <Button size="small" disabled={industries.length === 0} onClick={(event) => setAnchor(event.currentTarget)}>
        Industries ({selectedIndustryKeys.size}/{industries.length})
      </Button>
      <Menu anchorEl={anchor} open={anchor !== null} onClose={() => setAnchor(null)}>
        <MenuItem
          disabled={allSelected}
          onClick={() => setSelectedIndustryKeys(new Set(industries.map((industry) => industry.key)))}
        >
          Check all
        </MenuItem>
        <MenuItem disabled={selectedIndustryKeys.size === 0} onClick={() => setSelectedIndustryKeys(new Set())}>
          Uncheck all
        </MenuItem>
        {industries.map((industry) => (
          <MenuItem key={industry.key} onClick={() => toggleIndustry(industry.key)}>
            <Checkbox size="small" checked={selectedIndustryKeys.has(industry.key)} />
            {industry.name}
          </MenuItem>
        ))}
      </Menu>
    </>
  );
}

function AutomaticTab({
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
  const [unassignedOnly, setUnassignedOnly] = useState(false);
  const [selectedSymbols, setSelectedSymbols] = useState<Set<string>>(new Set());
  const [jobs, setJobs] = useState<ThemeAiJobSummary[]>([]);
  const [selectedJob, setSelectedJob] = useState<ThemeAiJob>();
  const [selectedId, setSelectedId] = useState<number>();
  const [busy, setBusy] = useState(false);
  const selectedSummary = jobs.find((job) => job.id === selectedId);
  const selected = selectedJob?.id === selectedSummary?.id ? selectedJob : undefined;
  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return tickers.filter(
      (ticker) =>
        (!unassignedOnly || ticker.assignments.length === 0) &&
        matchesIndustryFilter(ticker, selectedIndustryKeys) &&
        (!query ||
          ticker.symbol.toLowerCase().includes(query) ||
          ticker.name?.toLowerCase().includes(query)),
    );
  }, [search, selectedIndustryKeys, tickers, unassignedOnly]);

  useEffect(() => {
    const visible = new Set(filtered.map((ticker) => ticker.symbol));
    setSelectedSymbols((current) => {
      const next = new Set([...current].filter((symbol) => visible.has(symbol)));
      return next.size === current.size ? current : next;
    });
  }, [filtered]);

  const reloadJobs = async () => setJobs(await fetchThemeAiJobs());
  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const next = await fetchThemeAiJobs();
        if (!active) return;
        setJobs(next);
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
        <TextField
          size="small"
          placeholder="Search tickers"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <div className="ticker-selection-controls">
          <IndustryFilter
            industries={industries}
            selectedIndustryKeys={selectedIndustryKeys}
            setSelectedIndustryKeys={setSelectedIndustryKeys}
          />
          <Button
            size="small"
            variant={unassignedOnly ? "contained" : "text"}
            onClick={() => setUnassignedOnly((current) => !current)}
          >
            Unassigned
          </Button>
          <Button
            size="small"
            disabled={filtered.length === 0}
            onClick={() => {
              const symbols = filtered.map((ticker) => ticker.symbol);
              enrichTickers(symbols.filter((symbol) => !selectedSymbols.has(symbol)), onError);
              setSelectedSymbols(new Set(symbols));
            }}
          >
            Select all
          </Button>
          <Button
            size="small"
            disabled={selectedSymbols.size === 0}
            onClick={() => setSelectedSymbols(new Set())}
          >
            Select none
          </Button>
        </div>
        <ol className="theme-management-list">
          {filtered.map((ticker) => (
            <li key={ticker.symbol}>
              <div className="ticker-assignment-row">
                <Checkbox
                  size="small"
                  checked={selectedSymbols.has(ticker.symbol)}
                  onChange={() => {
                    if (!selectedSymbols.has(ticker.symbol)) {
                      enrichTickers([ticker.symbol], onError);
                    }
                    setSelectedSymbols((current) => {
                      const next = new Set(current);
                      next.has(ticker.symbol) ? next.delete(ticker.symbol) : next.add(ticker.symbol);
                      return next;
                    });
                  }}
                />
                <div className="theme-management-list-item">
                  <span>
                    <strong>{ticker.symbol}</strong>
                    <small>{ticker.name ?? "Unknown company"}</small>
                  </span>
                  <Chip size="small" label={ticker.assignments.length} />
                </div>
              </div>
            </li>
          ))}
        </ol>
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
              <Typography component="h2">Jobs ({jobs.length})</Typography>
            </div>
            <ol className="theme-management-list">
              {jobs.map((job) => (
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
                    <Chip size="small" label={job.status} color={jobStatusColor(job.status)} />
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
                    <Chip label={selected.status} color={jobStatusColor(selected.status)} />
                    {selected.status === "completed" && (
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
                        Apply
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
                {selected.error && <Typography color="error">{selected.error}</Typography>}
                {selected.suggestions && (
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
                {selected.response && (
                  <TextField
                    multiline
                    minRows={8}
                    label="Raw response"
                    value={selected.response}
                    InputProps={{ readOnly: true }}
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

function jobStatusColor(status: ThemeAiJob["status"]): "default" | "info" | "success" | "error" {
  if (status === "pending" || status === "running") return "info";
  if (status === "completed" || status === "applied") return "success";
  if (status === "failed") return "error";
  return "default";
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unexpected error";
}
