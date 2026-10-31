import { useEffect, useState } from "react";
import { observeMarketHours, type MarketHoursState } from "../api/marketHours";

export function useMarketHours() {
  const [state, setState] = useState<MarketHoursState>({ beforeClose: false });
  useEffect(() => observeMarketHours(setState), []);
  return state;
}
