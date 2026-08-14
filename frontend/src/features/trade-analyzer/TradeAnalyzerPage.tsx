import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Typography } from "@mui/material";
import {
  fetchTradeAnalyzer,
  saveTradeJournal,
  type AnalyzerTrade,
  type TradeAnalyzerSnapshot,
  type TradeFilters,
  type TradeTag,
} from "../../api/tradeAnalyzer";
import { SplitPane } from "../../components/SplitPane";
import { Toast } from "../../components/Toast";
import { AnalyzerToolbar } from "./AnalyzerToolbar";
import { ImportDialog } from "./ImportDialog";
import { ManualTradeDialog } from "./ManualTradeDialog";
import { MonthlyTradeList } from "./MonthlyTradeList";
import { TradeChartPane } from "./TradeChartPane";
import "./trade-analyzer.css";

const chartVisibleKey = "trade-analyzer.chart-visible";
const workspaceSplitKey = "trade-analyzer.workspace-split";

export function TradeAnalyzerPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const filters = useMemo(() => filtersFromSearch(searchParams), [searchParams]);
  const selectedTradeId = optionalNumber(searchParams.get("trade"));
  const [snapshot, setSnapshot] = useState<TradeAnalyzerSnapshot>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [importOpen, setImportOpen] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [editingTrade, setEditingTrade] = useState<AnalyzerTrade>();
  const [chartVisible, setChartVisible] = useState(() => {
    const stored = localStorage.getItem(chartVisibleKey);
    return stored === null ? window.innerWidth >= 900 : stored !== "false";
  });
  const [workspaceSplit, setWorkspaceSplit] = useState(() => finiteNumber(localStorage.getItem(workspaceSplitKey), 52));
  useEffect(() => {
    const controller = new AbortController();
    void fetchTradeAnalyzer(filters, controller.signal)
      .then((next) => {
        if (next.accounts.length > 0 && !next.accounts.some(({ id }) => id === filters.account)) {
          setSearchParams((current) => {
            const params = new URLSearchParams(current);
            params.set("account", String(next.accounts[0].id));
            params.delete("trade");
            return params;
          }, { replace: true });
          return;
        }
        setSnapshot(next);
        setError(undefined);
      })
      .catch((requestError: unknown) => {
        if (requestError instanceof Error && requestError.name === "AbortError") return;
        setError(requestError instanceof Error ? requestError.message : "Failed to load trades");
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [filters, setSearchParams]);

  const selectedTrade = useMemo(
    () => snapshot?.trades.find(({ id }) => id === selectedTradeId),
    [selectedTradeId, snapshot?.trades],
  );

  const changeFilters = useCallback((next: TradeFilters) => {
    setLoading(true);
    setSearchParams((current) => {
      const params = new URLSearchParams(current);
      setOptional(params, "account", next.account);
      setOptional(params, "month", next.month);
      setOptional(params, "status", next.status);
      setOptional(params, "q", next.query);
      setOptional(params, "tags", next.tagIds?.join(","));
      setOptional(params, "tagMode", next.tagIds?.length ? next.tagMode : undefined);
      params.delete("trade");
      return params;
    });
  }, [setSearchParams]);

  const selectTrade = useCallback((tradeId: number) => {
    setSearchParams((current) => {
      const params = new URLSearchParams(current);
      params.set("trade", String(tradeId));
      return params;
    }, { replace: true });
  }, [setSearchParams]);

  const applySnapshot: (next: TradeAnalyzerSnapshot) => void = () => {
    setNotice("Changes applied");
    setLoading(true);
    void fetchTradeAnalyzer(filters)
      .then((next) => {
        setSnapshot(next);
        setError(undefined);
      })
      .catch((requestError: unknown) => {
        setError(requestError instanceof Error ? requestError.message : "Failed to refresh trades");
      })
      .finally(() => setLoading(false));
  };

  const saveJournal = async (trade: AnalyzerTrade, comment: string, tags: TradeTag[]) => {
    try {
      const updated = await saveTradeJournal(trade.id, trade.revision, comment, tags);
      setSnapshot((current) => current === undefined ? current : {
        ...current,
        tags: [...new Map([...current.tags, ...updated.tags].map((tag) => [tag.id, tag])).values()],
        trades: current.trades.map((item) => item.id === updated.id ? updated : item),
      });
      setNotice("Journal saved");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Failed to save journal");
      throw saveError;
    }
  };

  const accounts = snapshot?.accounts ?? [];
  const tags = snapshot?.tags ?? [];
  const months = snapshot?.months ?? [];
  const trades = snapshot?.trades ?? [];

  return (
    <main className="trade-analyzer-page">
      <AnalyzerToolbar
        accounts={accounts}
        tags={tags}
        months={months}
        filters={filters}
        chartVisible={chartVisible}
        onFiltersChange={changeFilters}
        onClearFilters={() => changeFilters({ account: filters.account })}
        onImport={() => setImportOpen(true)}
        onAddManual={() => setManualOpen(true)}
        onToggleChart={() => {
          const next = !chartVisible;
          setChartVisible(next);
          localStorage.setItem(chartVisibleKey, String(next));
        }}
      />
      {error && snapshot === undefined ? (
        <div className="panel-status trade-load-error">
          <Typography color="error">{error}</Typography>
        </div>
      ) : (
        <div className="trade-analyzer-workspace">
          <SplitPane
            orientation="horizontal"
            initialSplit={workspaceSplit}
            secondVisible={chartVisible}
            onSplitChange={(value) => {
              setWorkspaceSplit(value);
              localStorage.setItem(workspaceSplitKey, String(value));
            }}
            first={(
              <MonthlyTradeList
                accounts={accounts}
                months={months}
                trades={trades}
                tags={tags}
                loading={loading}
                showJournalColumns={!chartVisible}
                selectedTradeId={selectedTrade?.id}
                onSelectTrade={selectTrade}
                onSaveJournal={saveJournal}
                onEditTrade={setEditingTrade}
              />
            )}
            second={chartVisible ? <TradeChartPane trade={selectedTrade} /> : null}
          />
        </div>
      )}
      {importOpen && <ImportDialog open onClose={() => setImportOpen(false)} onApplied={applySnapshot} onError={setError} />}
      {manualOpen && <ManualTradeDialog open accounts={accounts} onClose={() => setManualOpen(false)} onApplied={applySnapshot} onError={setError} />}
      {editingTrade && <ManualTradeDialog open trade={editingTrade} accounts={accounts} onClose={() => setEditingTrade(undefined)} onApplied={(next) => { setEditingTrade(undefined); applySnapshot(next); }} onError={setError} />}
      <Toast message={error ?? notice} severity={error ? "error" : "success"} onClose={() => { setError(undefined); setNotice(undefined); }} />
    </main>
  );
}

function filtersFromSearch(params: URLSearchParams): TradeFilters {
  const tagIds = params.get("tags")?.split(",").map(Number).filter(Number.isFinite);
  return {
    account: optionalNumber(params.get("account")),
    month: params.get("month") || undefined,
    status: params.get("status") || undefined,
    query: params.get("q") || undefined,
    tagIds: tagIds?.length ? tagIds : undefined,
    tagMode: params.get("tagMode") === "all" ? "all" : "any",
  };
}

function optionalNumber(value: string | null) {
  if (value === null || value === "") return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function setOptional(params: URLSearchParams, key: string, value: string | number | undefined) {
  if (value === undefined || value === "") params.delete(key);
  else params.set(key, String(value));
}

function finiteNumber(value: string | null, fallback: number) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 25 && number <= 75 ? number : fallback;
}
