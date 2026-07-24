import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import KeyboardArrowDownIcon from "@mui/icons-material/KeyboardArrowDown";
import KeyboardArrowUpIcon from "@mui/icons-material/KeyboardArrowUp";
import SearchIcon from "@mui/icons-material/Search";
import { IconButton, InputAdornment, TextField, Tooltip } from "@mui/material";
import type { GlobalSearchResult } from "../../api/globalSearch";
import { unassignedGroupKey } from "./constants";
import type { GroupMode, GroupRanking } from "./types";
import { useGlobalSearch } from "./useGlobalSearch";

const localResultLimit = 12;
const emptyGlobalResults: GlobalSearchResult[] = [];

interface TickerLensSearchProps {
  bounded: boolean;
  mode: GroupMode;
  groups: GroupRanking[];
  tickerSymbols: string[];
  onSelectGroup: (key: string) => void;
  onSelectTicker: (symbol: string) => void;
  onSelectGlobal: (result: GlobalSearchResult) => void;
}

interface SearchAction {
  id: string;
  select: () => void;
}

interface SearchResultButtonProps {
  id: string;
  active: boolean;
  children: ReactNode;
  resultRefs: React.MutableRefObject<Map<string, HTMLButtonElement>>;
  onActivate: (id: string) => void;
  onSelect: (id: string) => void;
}

export function TickerLensSearch({
  bounded,
  mode,
  groups,
  tickerSymbols,
  onSelectGroup,
  onSelectTicker,
  onSelectGlobal,
}: TickerLensSearchProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState({ mode, query: "" });
  const [activeId, setActiveId] = useState<string>();
  const inputRef = useRef<HTMLInputElement>(null);
  const resultRefs = useRef(new Map<string, HTMLButtonElement>());
  const focusAndSelectQuery = useCallback(() => {
    window.setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 0);
  }, []);
  const searchableGroups = useMemo(
    () => mode === "theme" && !groups.some((group) => group.key === unassignedGroupKey)
      ? [...groups, { key: unassignedGroupKey, name: "Unassigned", performance: null, absolute_strength: null }]
      : groups,
    [groups, mode],
  );
  const query = search.mode === mode ? search.query : "";
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const matchingGroups = useMemo(
    () => normalizedQuery === "" ? [] : searchableGroups
      .filter((group) => group.name.toLocaleLowerCase().includes(normalizedQuery))
      .slice(0, localResultLimit),
    [normalizedQuery, searchableGroups],
  );
  const matchingTickers = useMemo(
    () => normalizedQuery === "" ? [] : tickerSymbols
      .filter((symbol) => symbol.toLocaleLowerCase().includes(normalizedQuery))
      .sort((left, right) => {
        const leftStarts = left.toLocaleLowerCase().startsWith(normalizedQuery);
        const rightStarts = right.toLocaleLowerCase().startsWith(normalizedQuery);
        return leftStarts === rightStarts ? left.localeCompare(right) : leftStarts ? -1 : 1;
      })
      .slice(0, localResultLimit),
    [normalizedQuery, tickerSymbols],
  );
  const globalSearch = useGlobalSearch(query, bounded && open);
  const globalGroups = globalSearch.results?.groups ?? emptyGlobalResults;
  const globalTickers = globalSearch.results?.tickers ?? emptyGlobalResults;
  const actions = useMemo<SearchAction[]>(
    () => [
      ...matchingGroups.map((group) => ({
        id: `local-group-${group.key}`,
        select: () => onSelectGroup(group.key),
      })),
      ...matchingTickers.map((symbol) => ({
        id: `local-ticker-${symbol}`,
        select: () => onSelectTicker(symbol),
      })),
      ...globalGroups.map((result) => ({
        id: globalResultId(result),
        select: () => onSelectGlobal(result),
      })),
      ...globalTickers.map((result) => ({
        id: globalResultId(result),
        select: () => onSelectGlobal(result),
      })),
    ],
    [
      globalGroups,
      globalTickers,
      matchingGroups,
      matchingTickers,
      onSelectGlobal,
      onSelectGroup,
      onSelectTicker,
    ],
  );
  const effectiveActiveId = actions.some((action) => action.id === activeId)
    ? activeId
    : actions[0]?.id;

  const updateQuery = useCallback((nextQuery: string) => {
    setSearch({ mode, query: nextQuery });
    setActiveId(undefined);
  }, [mode]);

  const selectResult = (id: string | undefined) => {
    if (id === undefined) return;
    const action = actions.find((candidate) => candidate.id === id);
    if (action === undefined) return;
    action.select();
    setOpen(false);
  };

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        (event.ctrlKey || event.metaKey) &&
        event.key.toLocaleLowerCase() === "f" &&
        document.querySelector('[role="dialog"][aria-modal="true"]') === null
      ) {
        event.preventDefault();
        setOpen(true);
        focusAndSelectQuery();
      } else if (event.key === "Escape" && open) {
        event.preventDefault();
        if (query !== "") updateQuery("");
        else setOpen(false);
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [focusAndSelectQuery, open, query, updateQuery]);

  if (!open) {
    return (
      <Tooltip title="Search groups and tickers (Ctrl/Cmd+F)">
        <IconButton
          className="ticker-lens-search-toggle"
          size="small"
          aria-label="Open search"
          onClick={() => {
            setOpen(true);
            focusAndSelectQuery();
          }}
        >
          <KeyboardArrowUpIcon fontSize="small" />
        </IconButton>
      </Tooltip>
    );
  }

  const hasLocalResults = matchingGroups.length > 0 || matchingTickers.length > 0;
  const hasGlobalResults = globalGroups.length > 0 || globalTickers.length > 0;
  const localRanges = (label: string) => substringRanges(label, query.trim());
  return (
    <section className="ticker-lens-search" aria-label="Search groups and tickers">
      {normalizedQuery !== "" && (
        <div className="ticker-lens-search-results">
          {bounded ? (
            <>
              {hasLocalResults && (
                <SearchRegion title="Local">
                  {matchingGroups.length > 0 && (
                    <SearchColumn title={mode === "industry" ? "Industries" : "Themes"}>
                      {matchingGroups.map((group) => {
                        const id = `local-group-${group.key}`;
                        return (
                          <SearchResultButton
                            id={id}
                            active={effectiveActiveId === id}
                            key={id}
                            resultRefs={resultRefs}
                            onActivate={setActiveId}
                            onSelect={selectResult}
                          >
                            <HighlightedLabel label={group.name} ranges={localRanges(group.name)} />
                          </SearchResultButton>
                        );
                      })}
                    </SearchColumn>
                  )}
                  {matchingTickers.length > 0 && (
                    <SearchColumn title="Tickers">
                      {matchingTickers.map((symbol) => {
                        const id = `local-ticker-${symbol}`;
                        return (
                          <SearchResultButton
                            id={id}
                            active={effectiveActiveId === id}
                            key={id}
                            resultRefs={resultRefs}
                            onActivate={setActiveId}
                            onSelect={selectResult}
                          >
                            <HighlightedLabel label={symbol} ranges={localRanges(symbol)} />
                          </SearchResultButton>
                        );
                      })}
                    </SearchColumn>
                  )}
                </SearchRegion>
              )}
              <SearchRegion title="Global" global>
                {globalSearch.loading && <SearchStatus>Searching global market…</SearchStatus>}
                {globalSearch.error !== undefined && (
                  <SearchStatus>Global search unavailable</SearchStatus>
                )}
                {!globalSearch.loading &&
                  globalSearch.error === undefined &&
                  !hasGlobalResults &&
                  <SearchStatus>No global matches</SearchStatus>}
                {globalGroups.length > 0 && (
                  <SearchColumn title="Industries & Themes">
                    {globalGroups.map((result) => (
                      <GlobalResultButton
                        activeId={effectiveActiveId}
                        key={globalResultId(result)}
                        result={result}
                        resultRefs={resultRefs}
                        onActivate={setActiveId}
                        onSelect={selectResult}
                      />
                    ))}
                  </SearchColumn>
                )}
                {globalTickers.length > 0 && (
                  <SearchColumn title="Tickers">
                    {globalTickers.map((result) => (
                      <GlobalResultButton
                        activeId={effectiveActiveId}
                        key={globalResultId(result)}
                        result={result}
                        resultRefs={resultRefs}
                        onActivate={setActiveId}
                        onSelect={selectResult}
                      />
                    ))}
                  </SearchColumn>
                )}
              </SearchRegion>
            </>
          ) : (
            <div className="ticker-lens-search-grid">
              {!hasLocalResults && <SearchStatus>No matches</SearchStatus>}
              {matchingGroups.length > 0 && (
                <SearchColumn title={mode === "industry" ? "Industries" : "Themes"}>
                  {matchingGroups.map((group) => {
                    const id = `local-group-${group.key}`;
                    return (
                      <SearchResultButton
                        id={id}
                        active={effectiveActiveId === id}
                        key={id}
                        resultRefs={resultRefs}
                        onActivate={setActiveId}
                        onSelect={selectResult}
                      >
                        <HighlightedLabel label={group.name} ranges={localRanges(group.name)} />
                      </SearchResultButton>
                    );
                  })}
                </SearchColumn>
              )}
              {matchingTickers.length > 0 && (
                <SearchColumn title="Tickers">
                  {matchingTickers.map((symbol) => {
                    const id = `local-ticker-${symbol}`;
                    return (
                      <SearchResultButton
                        id={id}
                        active={effectiveActiveId === id}
                        key={id}
                        resultRefs={resultRefs}
                        onActivate={setActiveId}
                        onSelect={selectResult}
                      >
                        <HighlightedLabel label={symbol} ranges={localRanges(symbol)} />
                      </SearchResultButton>
                    );
                  })}
                </SearchColumn>
              )}
            </div>
          )}
        </div>
      )}
      <div className="ticker-lens-search-input">
        <TextField
          inputRef={inputRef}
          value={query}
          size="small"
          placeholder={`Search ${mode === "industry" ? "industries" : "themes"} and resolved tickers`}
          onChange={(event) => updateQuery(event.target.value)}
          onKeyDown={(event) => {
            if (actions.length === 0) return;
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              const currentIndex = actions.findIndex((action) => action.id === effectiveActiveId);
              const direction = event.key === "ArrowDown" ? 1 : -1;
              const nextIndex = (currentIndex + direction + actions.length) % actions.length;
              const nextId = actions[nextIndex]!.id;
              setActiveId(nextId);
              resultRefs.current.get(nextId)?.scrollIntoView({ block: "nearest" });
            } else if (event.key === "Enter") {
              event.preventDefault();
              selectResult(effectiveActiveId);
            }
          }}
          slotProps={{
            htmlInput: { maxLength: 64 },
            input: {
              startAdornment: <InputAdornment position="start"><SearchIcon fontSize="small" /></InputAdornment>,
            },
          }}
        />
        <Tooltip title="Collapse search">
          <IconButton size="small" aria-label="Collapse search" onClick={() => setOpen(false)}>
            <KeyboardArrowDownIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </div>
    </section>
  );
}

function SearchRegion({
  title,
  global = false,
  children,
}: {
  title: string;
  global?: boolean;
  children: ReactNode;
}) {
  return (
    <section className={`ticker-lens-search-region${global ? " ticker-lens-search-region-global" : ""}`}>
      <h2>{title}</h2>
      <div className="ticker-lens-search-grid">{children}</div>
    </section>
  );
}

function SearchColumn({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="ticker-lens-search-section">
      <h3>{title}</h3>
      {children}
    </div>
  );
}

function SearchStatus({ children }: { children: ReactNode }) {
  return <div className="ticker-lens-search-empty">{children}</div>;
}

function SearchResultButton({
  id,
  active,
  children,
  resultRefs,
  onActivate,
  onSelect,
}: SearchResultButtonProps) {
  return (
    <button
      className={active ? "active" : undefined}
      ref={(element) => {
        if (element === null) resultRefs.current.delete(id);
        else resultRefs.current.set(id, element);
      }}
      type="button"
      onMouseEnter={() => onActivate(id)}
      onClick={() => onSelect(id)}
    >
      {children}
    </button>
  );
}

function GlobalResultButton({
  result,
  activeId,
  resultRefs,
  onActivate,
  onSelect,
}: {
  result: GlobalSearchResult;
  activeId: string | undefined;
  resultRefs: React.MutableRefObject<Map<string, HTMLButtonElement>>;
  onActivate: (id: string) => void;
  onSelect: (id: string) => void;
}) {
  const id = globalResultId(result);
  return (
    <SearchResultButton
      id={id}
      active={activeId === id}
      resultRefs={resultRefs}
      onActivate={onActivate}
      onSelect={onSelect}
    >
      <span className="ticker-lens-search-result-label">
        <HighlightedLabel label={result.label} ranges={result.matches} />
      </span>
      {result.type !== "ticker" && (
        <span className="ticker-lens-search-result-type">{result.type}</span>
      )}
    </SearchResultButton>
  );
}

function HighlightedLabel({ label, ranges }: { label: string; ranges: Array<[number, number]> }) {
  if (ranges.length === 0) return label;
  const characters = Array.from(label);
  const parts: ReactNode[] = [];
  let position = 0;
  for (const [start, end] of ranges) {
    if (start > position) parts.push(characters.slice(position, start).join(""));
    parts.push(<mark key={`${start}-${end}`}>{characters.slice(start, end).join("")}</mark>);
    position = end;
  }
  if (position < characters.length) parts.push(characters.slice(position).join(""));
  return parts;
}

function substringRanges(label: string, query: string): Array<[number, number]> {
  const labelCharacters = Array.from(label);
  const queryCharacters = Array.from(query);
  if (queryCharacters.length === 0) return [];
  const foldedLabel = labelCharacters.map((character) => character.toLocaleLowerCase());
  const foldedQuery = queryCharacters.map((character) => character.toLocaleLowerCase());
  for (let start = 0; start <= foldedLabel.length - foldedQuery.length; start += 1) {
    if (foldedQuery.every((character, index) => foldedLabel[start + index] === character)) {
      return [[start, start + foldedQuery.length]];
    }
  }
  return [];
}

function globalResultId(result: GlobalSearchResult) {
  return `global-${result.type}-${result.key}`;
}
