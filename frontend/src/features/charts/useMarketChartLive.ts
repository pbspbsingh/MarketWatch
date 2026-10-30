import { useEffect } from "react";
import { useStore } from "zustand";
import { emptyLiveChart, liveChartKey, livePrices, type LiveChartResource } from "../../api/livePrices";
import { useVolumeRunRate } from "../../shared/useVolumeRunRate";

export function useMarketChartLive(resource: LiveChartResource) {
  const key = liveChartKey(resource);
  const live = useStore(livePrices.store, state => state.charts[key] ?? emptyLiveChart);
  const transportError = useStore(livePrices.store, state => state.error);
  const { control, receive } = useVolumeRunRate(resource.volume_run_rate ? resource.symbol : undefined);
  useEffect(() => livePrices.observeChart(JSON.parse(key) as LiveChartResource), [key]);
  useEffect(() => {
    if (live.volumeRunRate !== undefined) receive(live.volumeRunRate);
  }, [live.volumeRunRate, receive]);
  return { ...live, error: live.error ?? transportError, volumeRunRate: control };
}
