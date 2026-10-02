import { marketDataSymbol } from "./marketChart";

export interface VolumeRunRateState {
  symbol: string;
  market_date: string;
  visible: boolean;
  cached: boolean;
  ratio: number | null;
  sample_days: number;
  updated_at: string | null;
  calculated_at: string;
}

export function isVolumeRunRateState(state: VolumeRunRateState): boolean {
  return typeof state?.symbol === "string"
    && /^\d{4}-\d{2}-\d{2}$/.test(state.market_date)
    && typeof state.visible === "boolean"
    && typeof state.cached === "boolean"
    && (state.ratio === null || Number.isFinite(state.ratio) && state.ratio >= 0)
    && Number.isInteger(state.sample_days) && state.sample_days >= 0
    && typeof state.calculated_at === "string" && Number.isFinite(Date.parse(state.calculated_at))
    && (state.updated_at === null || typeof state.updated_at === "string" && Number.isFinite(Date.parse(state.updated_at)));
}

// HTTP activation and WebSocket updates can arrive in either order.
export function mergeVolumeRunRateState(
  current: VolumeRunRateState | undefined,
  incoming: VolumeRunRateState,
): VolumeRunRateState {
  return current?.symbol === incoming.symbol
    && Date.parse(current.calculated_at) > Date.parse(incoming.calculated_at)
    ? current : incoming;
}

export async function activateVolumeRunRate(symbol: string, signal: AbortSignal): Promise<VolumeRunRateState> {
  const requested = marketDataSymbol(symbol);
  const response = await fetch(`/api/market-chart/${encodeURIComponent(requested)}/volume-run-rate`, {
    method: "POST", signal,
  });
  if (!response.ok) throw new Error(await response.text() || "Failed to load VRR history");
  const state = await response.json() as VolumeRunRateState;
  if (!isVolumeRunRateState(state) || state.symbol !== requested) throw new Error("Invalid VRR response");
  return state;
}
