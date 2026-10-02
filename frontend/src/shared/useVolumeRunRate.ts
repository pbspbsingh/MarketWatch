import { useCallback, useEffect, useRef, useState } from "react";
import { marketDataSymbol } from "../api/marketChart";
import { activateVolumeRunRate, mergeVolumeRunRateState, type VolumeRunRateState } from "../api/volumeRunRate";

export interface VolumeRunRateControl {
  state: VolumeRunRateState;
  enabled: boolean;
  loading: boolean;
  error?: string;
  activate: () => void;
}

export function useVolumeRunRate(symbol: string | undefined) {
  const normalized = symbol === undefined ? undefined : marketDataSymbol(symbol);
  const [state, setState] = useState<VolumeRunRateState>();
  const [request, setRequest] = useState<{ symbol: string; loading: boolean; error?: string }>();
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => {
    pending.current?.abort();
    pending.current = null;
    setState(undefined);
    setRequest(undefined);
  }, [normalized]);

  const current = state?.symbol === normalized ? state : undefined;
  const enabled = current?.cached === true;
  const receive = useCallback((next: VolumeRunRateState) => {
    setState((current) => mergeVolumeRunRateState(current, next));
  }, []);
  const activate = () => {
    if (current === undefined || normalized === undefined || pending.current !== null || enabled) return;
    const controller = new AbortController();
    pending.current = controller;
    setRequest({ symbol: normalized, loading: true });
    void activateVolumeRunRate(normalized, controller.signal).then((next) => {
      if (controller.signal.aborted) return;
      receive(next);
      setRequest({ symbol: normalized, loading: false });
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      setRequest({ symbol: normalized, loading: false, error: error instanceof Error ? error.message : "Failed to load VRR" });
    }).finally(() => {
      if (pending.current === controller) pending.current = null;
    });
  };
  const control: VolumeRunRateControl | undefined = current === undefined ? undefined : {
    state: current, enabled, loading: request !== undefined && request.symbol === normalized && request.loading,
    error: request !== undefined && request.symbol === normalized ? request.error : undefined, activate,
  };
  return { control, receive };
}
