export type GlobalSearchResultType = "industry" | "theme" | "ticker";

export interface GlobalSearchResult {
  type: GlobalSearchResultType;
  key: string;
  label: string;
  matches: Array<[number, number]>;
}

export interface GlobalSearchResults {
  groups: GlobalSearchResult[];
  tickers: GlobalSearchResult[];
}

export async function fetchGlobalSearch(query: string, signal?: AbortSignal) {
  const response = await fetch(`/api/global-search?q=${encodeURIComponent(query)}`, { signal });
  if (!response.ok) {
    throw new Error(`Global search failed: HTTP ${response.status}`);
  }
  return response.json() as Promise<GlobalSearchResults>;
}
