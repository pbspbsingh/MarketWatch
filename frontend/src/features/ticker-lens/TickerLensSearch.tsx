import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import KeyboardArrowDownIcon from "@mui/icons-material/KeyboardArrowDown";
import KeyboardArrowUpIcon from "@mui/icons-material/KeyboardArrowUp";
import SearchIcon from "@mui/icons-material/Search";
import { IconButton, InputAdornment, TextField, Tooltip } from "@mui/material";
import { unassignedGroupKey } from "./constants";
import type { GroupMode, GroupRanking } from "./types";

const resultLimit = 12;

interface TickerLensSearchProps {
  mode: GroupMode;
  groups: GroupRanking[];
  tickerSymbols: string[];
  onSelectGroup: (key: string) => void;
  onSelectTicker: (symbol: string) => void;
}

export function TickerLensSearch({
  mode,
  groups,
  tickerSymbols,
  onSelectGroup,
  onSelectTicker,
}: TickerLensSearchProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState({ mode, query: "" });
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const resultRefs = useRef<Array<HTMLButtonElement | null>>([]);
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
      .slice(0, resultLimit),
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
      .slice(0, resultLimit),
    [normalizedQuery, tickerSymbols],
  );
  const results = useMemo(
    () => [
      ...matchingGroups.map((group) => ({ type: "group" as const, value: group.key })),
      ...matchingTickers.map((symbol) => ({ type: "ticker" as const, value: symbol })),
    ],
    [matchingGroups, matchingTickers],
  );

  const updateQuery = useCallback((nextQuery: string) => {
    setSearch({ mode, query: nextQuery });
    setActiveIndex(0);
  }, [mode]);

  const selectResult = (index: number) => {
    const result = results[index];
    if (result === undefined) return;
    if (result.type === "group") onSelectGroup(result.value);
    else onSelectTicker(result.value);
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

  const hasResults = matchingGroups.length > 0 || matchingTickers.length > 0;
  let resultIndex = 0;
  return (
    <section className="ticker-lens-search" aria-label="Search groups and tickers">
      {normalizedQuery !== "" && (
        <div className="ticker-lens-search-results">
          {!hasResults && <div className="ticker-lens-search-empty">No matches</div>}
          {matchingGroups.length > 0 && (
            <div className="ticker-lens-search-section">
              <h3>{mode === "industry" ? "Industries" : "Themes"}</h3>
              {matchingGroups.map((group) => {
                const index = resultIndex++;
                return (
                  <button
                    className={activeIndex === index ? "active" : undefined}
                    key={group.key}
                    ref={(element) => { resultRefs.current[index] = element; }}
                    type="button"
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => selectResult(index)}
                  >
                    {group.name}
                  </button>
                );
              })}
            </div>
          )}
          {matchingTickers.length > 0 && (
            <div className="ticker-lens-search-section">
              <h3>Tickers</h3>
              {matchingTickers.map((symbol) => {
                const index = resultIndex++;
                return (
                  <button
                    className={activeIndex === index ? "active" : undefined}
                    key={symbol}
                    ref={(element) => { resultRefs.current[index] = element; }}
                    type="button"
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => selectResult(index)}
                  >
                    {symbol}
                  </button>
                );
              })}
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
            if (results.length === 0) return;
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              const direction = event.key === "ArrowDown" ? 1 : -1;
              const next = (activeIndex + direction + results.length) % results.length;
              setActiveIndex(next);
              resultRefs.current[next]?.scrollIntoView({ block: "nearest" });
            } else if (event.key === "Enter") {
              event.preventDefault();
              selectResult(activeIndex);
            }
          }}
          slotProps={{
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
