import { useCallback, useState } from "react";
import { refreshIndustryMemberships, resolveTickerMembership } from "../../api/tickers";
import { Toast } from "../../components/Toast";
import { fetchGlobalGroupRankings } from "../ticker-lens/groupRankings";
import { TickerLens } from "../ticker-lens/TickerLens";
import { unassignedGroupKey } from "../ticker-lens/constants";
import type {
  ResolveGroupsRequest,
  ResolveTickersRequest,
  TickerUniverseSnapshot,
} from "../ticker-lens/types";
import { TickerStrengthProvider } from "../ticker-strength/TickerStrengthContext";
import { useTickerStrengthFeature } from "../ticker-strength/useTickerStrengthMetric";
import { IndustryMembershipRefreshDialog } from "./IndustryMembershipRefreshDialog";
import { MarketWatchToolbar } from "./MarketWatchToolbar";
import "./market-watch.css";

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
  return (
    <TickerStrengthProvider>
      <MarketWatchContent />
    </TickerStrengthProvider>
  );
}

function MarketWatchContent() {
  const tickerStrength = useTickerStrengthFeature();
  const [membershipRevision, setMembershipRevision] = useState(0);
  const [selection, setSelection] = useState<
    Pick<TickerUniverseSnapshot, "mode" | "groupKeys" | "groups">
  >({ mode: "industry", groupKeys: [], groups: [] });
  const [refreshingMembership, setRefreshingMembership] = useState(false);
  const [membershipRefreshTarget, setMembershipRefreshTarget] = useState<string[]>();
  const [refreshMessage, setRefreshMessage] = useState<{
    text: string;
    severity: "success" | "error";
  }>();
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
  const handleTickerUniverseChange = useCallback((snapshot: TickerUniverseSnapshot) => {
    setSelection((current) =>
      current.mode === snapshot.mode
        && current.groupKeys.join("\0") === snapshot.groupKeys.join("\0")
        && current.groups.map((group) => group.name).join("\0")
          === snapshot.groups.map((group) => group.name).join("\0")
        ? current
        : { mode: snapshot.mode, groupKeys: snapshot.groupKeys, groups: snapshot.groups }
    );
  }, []);
  const requestMembershipRefresh = useCallback(() => {
    if (selection.mode === "industry" && selection.groupKeys.length > 0) {
      setMembershipRefreshTarget([...selection.groupKeys]);
    }
  }, [selection]);
  const refreshMembership = useCallback(() => {
    if (membershipRefreshTarget === undefined) return;
    const industryKeys = membershipRefreshTarget;
    setMembershipRefreshTarget(undefined);
    setRefreshingMembership(true);
    void refreshIndustryMemberships(industryKeys)
      .then((result) => {
        setRefreshMessage({
          severity: "success",
          text: `Refreshed ${result.industry_count} ${result.industry_count === 1
            ? "industry"
            : "industries"}: ${result.ticker_count} tickers (${result.added_count} added, ${result.removed_count} removed)`,
        });
      })
      .catch((requestError: unknown) => {
        setRefreshMessage({
          severity: "error",
          text: requestError instanceof Error
            ? requestError.message
            : "Failed to refresh industry tickers",
        });
      })
      .finally(() => {
        setMembershipRevision((revision) => revision + 1);
        setRefreshingMembership(false);
      });
  }, [membershipRefreshTarget]);
  return (
    <section className="market-watch-page">
      <MarketWatchToolbar
        membershipRefreshDisabled={selection.mode !== "industry"
          || selection.groupKeys.length === 0}
        membershipRefreshTooltip={membershipRefreshTooltip(selection)}
        refreshingMembership={refreshingMembership}
        onRefreshMembership={requestMembershipRefresh}
      />
      <TickerLens
        accent="purple"
        universe={{
          type: "market-watch",
          resolveGroups,
          resolveTickers,
          resolveGroupCounts,
          revision: membershipRevision,
        }}
        metricExtensions={tickerStrength.metricExtensions}
        onTickerUniverseChange={handleTickerUniverseChange}
      />
      <Toast
        message={refreshMessage?.text}
        severity={refreshMessage?.severity}
        onClose={() => setRefreshMessage(undefined)}
      />
      {membershipRefreshTarget !== undefined && (
        <IndustryMembershipRefreshDialog
          industryCount={membershipRefreshTarget.length}
          onCancel={() => setMembershipRefreshTarget(undefined)}
          onConfirm={refreshMembership}
        />
      )}
    </section>
  );
}

function membershipRefreshTooltip(
  selection: Pick<TickerUniverseSnapshot, "mode" | "groups">,
) {
  if (selection.mode !== "industry") return "Switch to Industries to refresh memberships";
  const names = selection.groups.map((group) => group.name);
  if (names.length === 0) return "Select industries to refresh memberships";
  if (names.length === 1) return `Refresh membership of ${names[0]}`;
  return `Refresh membership of ${names.slice(0, -1).join(", ")} & ${names.at(-1)}`;
}
