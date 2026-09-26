import { lazy, Suspense, type Dispatch, type SetStateAction, useEffect, useMemo, useState } from "react";
import AddIcon from "@mui/icons-material/Add";
import { Button, Chip, CircularProgress, IconButton, TextField, Typography } from "@mui/material";
import {
  addThemeTicker,
  applyThemeSuggestions,
  deleteThemeTicker,
  generateThemePrompt,
  parseThemeSuggestions,
  replaceTickerThemes,
  type Theme,
  type ThemeSuggestion,
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
} from "./themeManagementUtils";

const MarketChartContainer = lazy(() =>
  import("../charts/MarketChartContainer").then(({ MarketChartContainer }) => ({
    default: MarketChartContainer,
  })),
);

export function AssignmentsTab({
  linkedTicker,
  themes,
  tickers,
  industries,
  selectedIndustryKeys,
  setSelectedIndustryKeys,
  unassignedOnly,
  setUnassignedOnly,
  unprocessedOnly,
  setUnprocessedOnly,
  onChanged,
  onError,
  onMessage,
}: {
  linkedTicker: string;
  themes: Theme[];
  tickers: ThemeTicker[];
  industries: IndustryFilterOption[];
  selectedIndustryKeys: Set<string>;
  setSelectedIndustryKeys: Dispatch<SetStateAction<Set<string> | undefined>>;
  unassignedOnly: boolean;
  setUnassignedOnly: Dispatch<SetStateAction<boolean>>;
  unprocessedOnly: boolean;
  setUnprocessedOnly: Dispatch<SetStateAction<boolean>>;
  onChanged: () => void;
  onError: (message: string) => void;
  onMessage: (message: string) => void;
}) {
  const [search, setSearch] = useState(linkedTicker);
  const [newSymbol, setNewSymbol] = useState("");
  const [selectedSymbol, setSelectedSymbol] = useState<string | undefined>(linkedTicker || undefined);
  const [batchSymbols, setBatchSymbols] = useState<Set<string>>(new Set());
  const [themeDraft, setThemeDraft] = useState<TickerThemeDraft>({ themeIds: [] });
  const [promptSession, setPromptSession] = useState<PromptSession>({
    key: "",
    status: "loading",
    prompt: "",
    response: "",
    suggestions: [],
  });
  const [busy, setBusy] = useState(false);
  const selectedTicker = tickers.find((ticker) => ticker.symbol === selectedSymbol);
  const batchTicker =
    batchSymbols.size === 1
      ? tickers.find((ticker) => batchSymbols.has(ticker.symbol))
      : undefined;
  const editedTicker = batchSymbols.size === 0 ? selectedTicker : batchTicker;
  const draftThemeIds = themeDraft.symbol === editedTicker?.symbol
    ? themeDraft.themeIds
    : editedTicker?.assignments.map((assignment) => assignment.theme_id) ?? [];
  const filtered = useMemo(
    () => filterThemeTickers(tickers, search, selectedIndustryKeys, unassignedOnly, unprocessedOnly),
    [search, selectedIndustryKeys, tickers, unassignedOnly, unprocessedOnly],
  );
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
  const activePromptSession = promptSession.key === promptFingerprint
    ? promptSession
    : {
      key: promptFingerprint,
      status: "loading" as const,
      prompt: "",
      response: "",
      suggestions: [],
    };
  const { prompt, response, suggestions } = activePromptSession;
  const promptLoading = batchSymbols.size > 1 && activePromptSession.status === "loading";

  useEffect(() => {
    if (batchSymbols.size < 2) return;

    let active = true;
    generateThemePrompt([...batchSymbols])
      .then((result) => {
        if (active) {
          setPromptSession({
            key: promptFingerprint,
            status: "ready",
            prompt: result.prompt,
            response: "",
            suggestions: [],
          });
        }
      })
      .catch((promptError: unknown) => {
        if (active) {
          setPromptSession({
            key: promptFingerprint,
            status: "error",
            prompt: "",
            response: "",
            suggestions: [],
          });
          onError(errorMessage(promptError));
        }
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
    setThemeDraft({
      symbol: editedTicker?.symbol,
      themeIds: draftThemeIds.includes(id)
        ? draftThemeIds.filter((themeId) => themeId !== id)
        : [...draftThemeIds, id],
    });
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
          <IndustryFilter
            industries={industries}
            selectedIndustryKeys={selectedIndustryKeys}
            setSelectedIndustryKeys={(update) => {
              setBatchSymbols(new Set());
              setSelectedIndustryKeys(update);
            }}
          />
          <TextField
            size="small"
            placeholder="Search tickers"
            value={search}
            onChange={(event) => {
              setBatchSymbols(new Set());
              setSearch(event.target.value);
            }}
          />
          <TickerFilters
            unprocessedOnly={unprocessedOnly}
            setUnprocessedOnly={(update) => {
              setBatchSymbols(new Set());
              setUnprocessedOnly(update);
            }}
            unassignedOnly={unassignedOnly}
            setUnassignedOnly={(update) => {
              setBatchSymbols(new Set());
              setUnassignedOnly(update);
            }}
          />
        </div>
        <TickerSelectionHeader
          selectedCount={batchSymbols.size}
          visibleCount={filtered.length}
          onChange={(selectAll) => {
            if (!selectAll) {
              setBatchSymbols(new Set());
              return;
            }
            const symbols = filtered.map((ticker) => ticker.symbol);
            enrichTickers(symbols.filter((symbol) => !batchSymbols.has(symbol)), onError);
            setBatchSymbols(new Set(symbols));
          }}
        />
        <VirtualTickerList
          tickers={filtered}
          search={search}
          selectedSymbols={batchSymbols}
          activeSymbol={editedTicker?.symbol}
          onToggle={(symbol) => {
            if (!batchSymbols.has(symbol)) enrichTickers([symbol], onError);
            setBatchSymbols((current) => {
              const next = new Set(current);
              if (next.has(symbol)) next.delete(symbol);
              else next.add(symbol);
              return next;
            });
          }}
          onOpen={(symbol) => {
            setBatchSymbols(new Set());
            setSelectedSymbol(symbol);
          }}
        />
        <div className="ticker-add-row">
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
      </aside>
      <main className={editedTicker === undefined
        ? "assignment-workspace"
        : "assignment-workspace assignment-workspace-with-chart"}>
        {editedTicker !== undefined && (
          <section className="assignment-card ticker-theme-editor">
            <div className="ticker-editor-details">
              <div className="ticker-profile">
                <Typography component="h2">
                  {editedTicker.symbol}
                  {editedTicker.name ? ` · ${editedTicker.name}` : ""}
                </Typography>
                <Typography color="text.secondary" title={editedTicker.description ?? undefined}>
                  {editedTicker.description ?? "No company description available."}
                </Typography>
              </div>
              <Typography color="text.secondary">
                Prefer one theme. Select a second only for a distinct, material business driver.
              </Typography>
              <div className="ticker-editor-actions">
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
              </div>
            </div>
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
          </section>
        )}
        {editedTicker !== undefined && (
          <section className="assignment-chart" aria-label={`${editedTicker.symbol} daily chart`}>
            <Suspense fallback={<div className="panel-status"><CircularProgress size="1rem" /></div>}>
              <MarketChartContainer
                key={editedTicker.symbol}
                symbol={editedTicker.symbol}
                companyName={editedTicker.name ?? undefined}
                interval="daily"
              />
            </Suspense>
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
                  slotProps={{ input: { inputComponent: "textarea", readOnly: true } }}
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
                  slotProps={{ input: { inputComponent: "textarea" } }}
                  onChange={(event) => setPromptSession({
                    ...activePromptSession,
                    response: event.target.value,
                  })}
                />
                <Button
                  disabled={busy || !response.trim()}
                  onClick={() =>
                    run(async () => {
                      setPromptSession({
                        ...activePromptSession,
                        suggestions: await parseThemeSuggestions(response),
                      });
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
                          setPromptSession({ ...activePromptSession, suggestions: [] });
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

interface TickerThemeDraft {
  symbol?: string;
  themeIds: number[];
}

interface PromptSession {
  key: string;
  status: "loading" | "ready" | "error";
  prompt: string;
  response: string;
  suggestions: ThemeSuggestion[];
}
