import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  fetchTickerStrengthBenchmarks,
  fetchTickerStrengthScores,
  type TickerStrengthBenchmark,
  type TickerStrengthBenchmarkCatalog,
  type TickerStrengthScore,
} from "../../api/tickerStrength";
import type { GroupMode } from "../ticker-lens/types";

const startDateStorageKey = "market-watch.ticker-strength-start-date";
const benchmarkStorageKey = "market-watch.ticker-strength-benchmark";

export type TickerStrengthUniverse = {
  symbols: string[];
  benchmarkContext?: {
    mode: GroupMode;
    groupKeys: string[];
  };
};

type Scope = {
  mode: GroupMode;
  groupKeys: string[];
  symbols: string[];
  selectionKey: string;
  requestKey: string;
};
type CatalogState = { scopeKey: string; catalog?: TickerStrengthBenchmarkCatalog; error?: string };
type ScoreState = { requestKey: string; scores: TickerStrengthScore[]; error?: string };
type TickerStrengthContextValue = {
  enabled: boolean;
  available: boolean;
  startDate: string;
  latestSession: string;
  benchmark: string;
  benchmarks: TickerStrengthBenchmark[];
  scores: TickerStrengthScore[];
  loading: boolean;
  calculating: boolean;
  error?: string;
  setEnabled: (enabled: boolean) => void;
  setStartDate: (date: string) => void;
  setBenchmark: (benchmark: string) => void;
  setUniverse: (universe: TickerStrengthUniverse) => void;
};

const TickerStrengthContext = createContext<TickerStrengthContextValue | undefined>(undefined);

export function TickerStrengthProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [enabled, setEnabled] = useState(false);
  const [storedStartDate, setStoredStartDate] = useState(() => localStorage.getItem(startDateStorageKey) ?? "");
  const [benchmark, setBenchmarkState] = useState(
    () => localStorage.getItem(benchmarkStorageKey)?.trim().toUpperCase() || "",
  );
  const [scope, setScope] = useState<Scope>(() => scopeFor({ symbols: [] }));
  const [catalogState, setCatalogState] = useState<CatalogState>({ scopeKey: "" });
  const [scoreState, setScoreState] = useState<ScoreState>({ requestKey: "", scores: [] });

  const setUniverse = useCallback((universe: TickerStrengthUniverse) => {
    const next = scopeFor(universe);
    setScope((current) => {
      if (current.requestKey === next.requestKey) return current;
      return current.selectionKey === next.selectionKey
        ? { ...next, groupKeys: current.groupKeys }
        : next;
    });
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    fetchTickerStrengthBenchmarks(scope.mode, scope.groupKeys, controller.signal)
      .then((catalog) => {
        if (controller.signal.aborted) return;
        const options = [catalog.global, ...catalog.contextual];
        setBenchmarkState((current) => {
          if (options.some((option) => option.symbol === current)) return current;
          localStorage.setItem(benchmarkStorageKey, catalog.global.symbol);
          return catalog.global.symbol;
        });
        setCatalogState({ scopeKey: scope.selectionKey, catalog });
      })
      .catch((requestError: unknown) => {
        if (requestError instanceof Error && requestError.name !== "AbortError") {
          setCatalogState({ scopeKey: scope.selectionKey, error: requestError.message });
        }
      });
    return () => controller.abort();
  }, [scope.groupKeys, scope.mode, scope.selectionKey]);

  const activeCatalog = catalogState.scopeKey === scope.selectionKey
    ? catalogState.catalog
    : undefined;
  const benchmarks = useMemo(
    () => activeCatalog === undefined ? [] : [activeCatalog.global, ...activeCatalog.contextual],
    [activeCatalog],
  );
  const latestSession = activeCatalog?.latest_session ?? "";
  const startDate = activeCatalog === undefined ? "" : validStartDate(
    storedStartDate, latestSession,
  ) ? storedStartDate : oneMonthBefore(latestSession);
  const selectionReady = enabled && scope.symbols.length > 0
    && benchmarks.some((option) => option.symbol === benchmark)
    && startDate !== "";
  const scoreRequestKey = selectionReady
    ? `${scope.requestKey}\u0002${benchmark}\u0002${startDate}\u0002${latestSession}`
    : "";

  useEffect(() => {
    if (scoreRequestKey === "" || scoreState.requestKey === scoreRequestKey) {
      return;
    }
    const controller = new AbortController();
    fetchTickerStrengthScores(scope.symbols, benchmark, startDate, controller.signal)
      .then((scores) => {
        if (!controller.signal.aborted) setScoreState({ requestKey: scoreRequestKey, scores });
      })
      .catch((requestError: unknown) => {
        if (requestError instanceof Error && requestError.name !== "AbortError") {
          setScoreState({ requestKey: scoreRequestKey, scores: [], error: requestError.message });
        }
      });
    return () => controller.abort();
  }, [benchmark, scope.symbols, scoreRequestKey, scoreState.requestKey, startDate]);

  const setStartDate = useCallback((date: string) => {
    if (!validStartDate(date, latestSession)) return;
    setStoredStartDate(date);
    localStorage.setItem(startDateStorageKey, date);
  }, [latestSession]);
  const setBenchmark = useCallback((symbol: string) => {
    setBenchmarkState(symbol);
    localStorage.setItem(benchmarkStorageKey, symbol);
  }, []);
  const loading = catalogState.scopeKey !== scope.selectionKey
    || (catalogState.catalog === undefined && catalogState.error === undefined);
  const error = catalogState.scopeKey === scope.selectionKey
    ? catalogState.error ?? (scoreState.requestKey === scoreRequestKey ? scoreState.error : undefined)
    : undefined;

  const value = useMemo<TickerStrengthContextValue>(() => ({
    enabled,
    available: scope.symbols.length > 0,
    startDate,
    latestSession,
    benchmark,
    benchmarks,
    scores: scoreState.requestKey === scoreRequestKey ? scoreState.scores : [],
    loading,
    calculating: scoreRequestKey !== "" && scoreState.requestKey !== scoreRequestKey,
    error,
    setEnabled,
    setStartDate,
    setBenchmark,
    setUniverse,
  }), [
    benchmark, benchmarks, enabled, error, latestSession, loading, scope.symbols.length,
    scoreRequestKey, scoreState, setBenchmark, setStartDate, setUniverse, startDate,
  ]);

  return <TickerStrengthContext value={value}>{children}</TickerStrengthContext>;
}

export function useTickerStrength() {
  const value = useContext(TickerStrengthContext);
  if (value === undefined) throw new Error("TickerStrengthProvider is missing");
  return value;
}

function scopeFor(universe: TickerStrengthUniverse): Scope {
  const mode = universe.benchmarkContext?.mode ?? "industry";
  const groupKeys = universe.benchmarkContext?.groupKeys ?? [];
  const symbols = universe.symbols;
  const normalizedGroups = [...groupKeys].sort();
  const normalizedSymbols = [...new Set(symbols)];
  const selectionKey = `${mode}\0${normalizedGroups.join("\0")}`;
  return {
    mode,
    groupKeys: normalizedGroups,
    symbols: normalizedSymbols,
    selectionKey,
    requestKey: `${selectionKey}\u0001${normalizedSymbols.join("\0")}`,
  };
}

function validStartDate(value: string, latest: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value > latest) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function oneMonthBefore(isoDate: string) {
  const [year, month, day] = isoDate.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year, month - 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month - 2, Math.min(day, lastDay))).toISOString().slice(0, 10);
}
