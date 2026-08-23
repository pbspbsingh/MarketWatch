import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  fetchTickerStrengthBenchmarks,
  fetchTickerStrengthScores,
  type TickerStrengthBenchmark,
  type TickerStrengthBenchmarkCatalog,
  type TickerStrengthScore,
} from "../../api/tickerStrength";
import type { GroupMode } from "../ticker-lens/types";

export const tickerStrengthMinimumSessions = 5;
export const tickerStrengthMaximumSessions = 150;
export const tickerStrengthDefaultSessions = 20;

const sessionsStorageKey = "market-watch.ticker-strength-sessions";
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
  draftSessions: number;
  committedSessions: number;
  benchmark: string;
  benchmarks: TickerStrengthBenchmark[];
  scores: TickerStrengthScore[];
  loading: boolean;
  calculating: boolean;
  error?: string;
  setEnabled: (enabled: boolean) => void;
  setDraftSessions: (sessions: number) => void;
  commitSessions: (sessions: number) => void;
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
  const [committedSessions, setCommittedSessions] = useState(readSessions);
  const [draftSessions, setDraftSessionsState] = useState(committedSessions);
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
  const selectionReady = enabled && scope.symbols.length > 0
    && benchmarks.some((option) => option.symbol === benchmark);
  const scoreRequestKey = selectionReady
    ? `${scope.requestKey}\u0002${benchmark}\u0002${committedSessions}`
    : "";

  useEffect(() => {
    if (scoreRequestKey === "" || scoreState.requestKey === scoreRequestKey) {
      return;
    }
    const controller = new AbortController();
    fetchTickerStrengthScores(scope.symbols, benchmark, committedSessions, controller.signal)
      .then((scores) => {
        if (!controller.signal.aborted) setScoreState({ requestKey: scoreRequestKey, scores });
      })
      .catch((requestError: unknown) => {
        if (requestError instanceof Error && requestError.name !== "AbortError") {
          setScoreState({ requestKey: scoreRequestKey, scores: [], error: requestError.message });
        }
      });
    return () => controller.abort();
  }, [benchmark, committedSessions, scope.symbols, scoreRequestKey, scoreState.requestKey]);

  const setDraftSessions = useCallback((sessions: number) => {
    setDraftSessionsState(clampSessions(sessions));
  }, []);
  const commitSessions = useCallback((sessions: number) => {
    const next = clampSessions(sessions);
    setDraftSessionsState(next);
    setCommittedSessions(next);
    localStorage.setItem(sessionsStorageKey, String(next));
  }, []);
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
    draftSessions,
    committedSessions,
    benchmark,
    benchmarks,
    scores: scoreState.requestKey === scoreRequestKey ? scoreState.scores : [],
    loading,
    calculating: scoreRequestKey !== "" && scoreState.requestKey !== scoreRequestKey,
    error,
    setEnabled,
    setDraftSessions,
    commitSessions,
    setBenchmark,
    setUniverse,
  }), [
    benchmark, benchmarks, commitSessions, committedSessions, draftSessions, enabled, error, loading, scope.symbols.length,
    scoreRequestKey, scoreState, setBenchmark, setDraftSessions, setUniverse,
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

function readSessions() {
  const storedSessions = Number(localStorage.getItem(sessionsStorageKey));
  return validSessions(storedSessions) ? storedSessions : tickerStrengthDefaultSessions;
}

function validSessions(value: number) {
  return Number.isInteger(value)
    && value >= tickerStrengthMinimumSessions
    && value <= tickerStrengthMaximumSessions;
}

function clampSessions(value: number) {
  return Math.min(tickerStrengthMaximumSessions, Math.max(tickerStrengthMinimumSessions, Math.round(value)));
}
