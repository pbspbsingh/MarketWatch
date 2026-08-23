import { useCallback, useMemo } from "react";
import type { TickerMetric } from "../ticker-lens/types";
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
  const tickerMetrics = useMemo(() => [metric], [metric]);
  const setEnabled = tickerStrength.setEnabled;
  const onTickerMetricChange = useCallback((metricId: string | undefined) => {
    setEnabled(metricId === tickerStrengthMetricId);
  }, [setEnabled]);
  return {
    active: tickerStrength.enabled,
    tickerMetrics,
    onTickerMetricChange,
    setUniverse: tickerStrength.setUniverse,
  };
}

function formatTickerStrength(value: number) {
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}`;
}
