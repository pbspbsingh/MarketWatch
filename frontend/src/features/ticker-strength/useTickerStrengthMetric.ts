import { useCallback, useMemo } from "react";
import type { TickerMetric, TickerMetricExtension } from "../ticker-lens/types";
import { useTickerStrength } from "./TickerStrengthContext";

export const tickerStrengthMetricId = "ticker-strength";

export function useTickerStrengthMetric() {
  const tickerStrength = useTickerStrength();
  return useMemo<TickerMetric>(() => {
    const scores = new Map(tickerStrength.scores.map((score) => [score.symbol, score.score]));
    const details = new Map(tickerStrength.scores.map((score) => [score.symbol, score]));
    return {
      id: tickerStrengthMetricId,
      label: "TS",
      values: scores,
      formatValue: formatTickerStrength,
      colorValue: (value) => value > 0
        ? "var(--color-positive)"
        : value < 0 ? "var(--color-negative)" : "var(--color-text)",
      tooltipLines: (symbol, value) => {
        const score = details.get(symbol);
        return score === undefined ? [] : [
          `${formatTickerStrength(value)} · ${tickerStrength.benchmark} · ${score.samples}/${score.sessions} days`,
        ];
      },
    };
  }, [tickerStrength.benchmark, tickerStrength.scores]);
}

export function useTickerStrengthFeature() {
  const tickerStrength = useTickerStrength();
  const metric = useTickerStrengthMetric();
  const setEnabled = tickerStrength.setEnabled;
  const setUniverse = tickerStrength.setUniverse;
  const onScopeChange = useCallback<TickerMetricExtension["onScopeChange"]>((snapshot) => {
    if (snapshot === null) {
      setUniverse({ symbols: [] });
      return;
    }
    setUniverse({
      symbols: snapshot.symbols,
      benchmarkContext: { mode: snapshot.mode, groupKeys: snapshot.groupKeys },
    });
  }, [setUniverse]);
  const onActiveChange = useCallback<TickerMetricExtension["onActiveChange"]>((active) => {
    setEnabled(active);
  }, [setEnabled]);
  const extension = useMemo<TickerMetricExtension>(() => ({
    metric,
    onScopeChange,
    onActiveChange,
  }), [metric, onActiveChange, onScopeChange]);
  const metricExtensions = useMemo(() => [extension], [extension]);
  return {
    metricExtensions,
  };
}

function formatTickerStrength(value: number) {
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}`;
}
