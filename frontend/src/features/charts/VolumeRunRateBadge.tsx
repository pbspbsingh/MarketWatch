import type { VolumeRunRateControl } from "../../shared/useVolumeRunRate";

export function VolumeRunRateBadge({ control }: { control: VolumeRunRateControl }) {
  const { state, enabled, loading, error, activate } = control;
  if (!state.visible) return null;
  const value = state.ratio === null ? "—" : `${state.ratio.toFixed(1)}×`;
  const asOf = state.updated_at === null ? "No live volume received" : `As of ${new Date(state.updated_at).toLocaleTimeString()}`;
  const title = `Volume Run Rate · ${state.sample_days} historical days · ${asOf}`;
  if (enabled) {
    const color = state.ratio === null ? "neutral"
      : state.ratio < 0.5 ? "low"
      : state.ratio <= 1 ? "below-average"
      : state.ratio >= 1.5 ? "high" : "above-average";
    return (
      <span className={`market-chart-metric-toggle market-chart-vrr-value market-chart-vrr-${color}`} title={title}>
        VRR: {value}
      </span>
    );
  }
  return (
    <button
      type="button"
      className="market-chart-metric-toggle market-chart-metric-hidden"
      aria-label="Show volume run rate"
      disabled={loading}
      title={error === undefined
        ? title
        : `${error} · Click to retry`}
      onClick={activate}
    >
      {loading ? "VRR…" : error === undefined ? "VRR" : "VRR ↻"}
    </button>
  );
}
