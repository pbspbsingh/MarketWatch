export type TopStocksPeriod = "week1" | "month1" | "months3" | "months6" | "year1";

export interface TopStocksSelection {
  period: TopStocksPeriod;
  count: number;
}

export interface TopStocksSnapshot {
  selections: TopStocksSelection[];
  symbols: string[];
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) throw new Error(`Top stocks request failed: HTTP ${response.status}`);
  return response.json() as Promise<T>;
}

export function fetchTopStocks(signal?: AbortSignal) {
  return request<TopStocksSnapshot | null>("/api/top-stocks", { signal });
}

export function replaceTopStocks(selections: TopStocksSelection[]) {
  return request<TopStocksSnapshot>("/api/top-stocks", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(selections),
  });
}

export function refreshTopStocks() {
  return request<TopStocksSnapshot | null>("/api/top-stocks/refresh", { method: "POST" });
}

export async function clearTopStocks() {
  const response = await fetch("/api/top-stocks", { method: "DELETE" });
  if (!response.ok) throw new Error(`Top stocks request failed: HTTP ${response.status}`);
}
