import { useEffect, useState } from "react";
import {
  fetchGlobalSearch,
  type GlobalSearchResults,
} from "../../api/globalSearch";

const debounceMilliseconds = 200;

interface GlobalSearchState {
  query: string;
  loading: boolean;
  results?: GlobalSearchResults;
  error?: string;
}

const idleState: GlobalSearchState = { query: "", loading: false };

export function useGlobalSearch(query: string, enabled: boolean): GlobalSearchState {
  const normalizedQuery = query.trim();
  const [state, setState] = useState<GlobalSearchState>(idleState);

  useEffect(() => {
    if (!enabled || normalizedQuery === "") return;

    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      fetchGlobalSearch(normalizedQuery, controller.signal)
        .then((results) => {
          if (!controller.signal.aborted) {
            setState({ query: normalizedQuery, loading: false, results });
          }
        })
        .catch((requestError: unknown) => {
          if (
            !controller.signal.aborted &&
            requestError instanceof Error &&
            requestError.name !== "AbortError"
          ) {
            setState({ query: normalizedQuery, loading: false, error: requestError.message });
          }
        });
    }, debounceMilliseconds);

    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [enabled, normalizedQuery]);

  if (!enabled || normalizedQuery === "") return idleState;
  return state.query === normalizedQuery
    ? state
    : { query: normalizedQuery, loading: true };
}
