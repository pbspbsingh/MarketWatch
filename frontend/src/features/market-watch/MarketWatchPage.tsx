import { useCallback, useMemo, useState } from "react";
import { resolveTickerMembership } from "../../api/tickers";
import { fetchGlobalGroupRankings } from "../ticker-lens/groupRankings";
import { TickerLens } from "../ticker-lens/TickerLens";
import { unassignedGroupKey } from "../ticker-lens/constants";
import type { ResolveGroupsRequest, ResolveTickersRequest, TickerMetric } from "../ticker-lens/types";
import { TickerStrengthProvider, useTickerStrength } from "../ticker-strength/TickerStrengthContext";
import { TickerStrengthToolbar } from "../ticker-strength/TickerStrengthToolbar";
import "../ticker-strength/ticker-strength.css";

const tickerSelection = (mode: ResolveTickersRequest["mode"], groupKeys: Set<string>) =>
  mode === "industry"
    ? ({ group_type: "industry", keys: [...groupKeys].sort() } as const)
    : ({
        group_type: "theme",
        ids: [...groupKeys]
          .filter((key) => key !== unassignedGroupKey)
          .map(Number),
        include_unassigned: groupKeys.has(unassignedGroupKey),
      } as const);

export function MarketWatchPage() {
  const [tickerStrengthSelected, setTickerStrengthSelected] = useState(false);
  const handleTickerMetricChange = useCallback((metricId: string | undefined) => {
    setTickerStrengthSelected(metricId === "ticker-strength");
  }, []);
  return (
    <TickerStrengthProvider enabled={tickerStrengthSelected}>
      <MarketWatchContent
        tickerStrengthSelected={tickerStrengthSelected}
        onTickerMetricChange={handleTickerMetricChange}
      />
    </TickerStrengthProvider>
  );
}

function MarketWatchContent({
  tickerStrengthSelected,
  onTickerMetricChange,
}: {
  tickerStrengthSelected: boolean;
  onTickerMetricChange: (metricId: string | undefined) => void;
}) {
  const tickerStrength = useTickerStrength();
  const resolveGroups = useCallback(({ mode, signal }: ResolveGroupsRequest) => {
    return fetchGlobalGroupRankings(mode, signal);
  }, []);
  const resolveTickers = useCallback(
    ({ mode, groupKeys, signal }: ResolveTickersRequest) =>
      resolveTickerMembership(tickerSelection(mode, groupKeys), signal),
    [],
  );
  const resolveGroupCounts = useCallback(
    async ({ mode, groupKeys, signal }: ResolveTickersRequest) => {
      const counts = new Map<string, number>();
      for (const groupKey of [...groupKeys].sort()) {
        const groupSelection = new Set([groupKey]);
        const symbols = await resolveTickerMembership(
          tickerSelection(mode, groupSelection),
          signal,
        );
        counts.set(groupKey, symbols.length);
      }
      return counts;
    },
    [],
  );
  const tickerStrengthMetric = useMemo<TickerMetric>(() => {
    const scores = new Map(tickerStrength.scores.map((score) => [score.symbol, score.score]));
    const details = new Map(tickerStrength.scores.map((score) => [score.symbol, score]));
    return {
      id: "ticker-strength",
      label: "TS",
      values: scores,
      formatValue: formatStrength,
      colorValue: (value) => value > 0
        ? "var(--color-positive)"
        : value < 0 ? "var(--color-negative)" : "var(--color-text)",
      tooltipLines: (symbol, value) => {
        const score = details.get(symbol);
        return score === undefined ? [] : [
          `${formatStrength(value)} · ${tickerStrength.benchmark} · ${score.samples}/${score.sessions} days`,
        ];
      },
    };
  }, [tickerStrength.benchmark, tickerStrength.scores]);
  const tickerMetrics = useMemo(() => [tickerStrengthMetric], [tickerStrengthMetric]);

  return (
    <section className="market-watch-page">
      <TickerStrengthToolbar disabled={!tickerStrengthSelected} />
      <TickerLens
        accent="purple"
        universe={{ type: "market-watch", resolveGroups, resolveTickers, resolveGroupCounts }}
        tickerMetrics={tickerMetrics}
        onTickerUniverseChange={tickerStrength.setUniverse}
        onTickerMetricChange={onTickerMetricChange}
      />
    </section>
  );
}

function formatStrength(value: number) {
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}`;
}
