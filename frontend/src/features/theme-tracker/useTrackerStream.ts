import { useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import { applicationEvents } from "../../api/applicationEvents";
import { createTrackerStore } from "./trackerStore";

export function useTrackerStream(marketDate: string | undefined) {
  const [store] = useState(createTrackerStore);
  const state = useStore(store);
  const refresh = useRef<() => void>(undefined);
  const previousDay = useRef<string>(undefined);
  useEffect(() => {
    let release: (() => void) | undefined;
    let active = true;
    const subscribe = () => {
      release?.();
      release = applicationEvents.observe({ domain: "tracker", resource: { mode: state.mode } }, value => {
        if (!active) return;
        if (value instanceof Error) store.getState().receive(value);
        else if (value.domain === "tracker") store.getState().receive(value.state);
      });
    };
    subscribe();
    refresh.current = subscribe;
    return () => { active = false; release?.(); refresh.current = undefined; };
  }, [state.mode, store]);
  useEffect(() => {
    if (marketDate === undefined) return;
    if (previousDay.current !== undefined && marketDate !== previousDay.current) refresh.current?.();
    previousDay.current = marketDate;
  }, [marketDate]);
  return state;
}
