export type TopStocksPeriod = "week1" | "month1" | "months3" | "months6" | "year1";

export interface TopStocksSelection {
  period: TopStocksPeriod;
  count: number;
}

export type TopStocksSource =
  | { kind: "periods"; selections: TopStocksSelection[]; apply_additional_filters: boolean }
  | { kind: "custom_screen"; screen_id: number };

export interface TopStocksSnapshot {
  source: TopStocksSource;
  symbols: string[];
  period_selections: TopStocksSelection[];
}

export interface TopStockScreen {
  id: number;
  name: string;
  url: string;
  max_stock_count: number;
}

export interface TopStockScreenInput {
  name: string;
  url: string;
  max_stock_count: number;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: init.body === undefined ? init.headers : { "Content-Type": "application/json", ...init.headers },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(body?.error ?? `Top stocks request failed: HTTP ${response.status}`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export function fetchTopStocks(signal?: AbortSignal) {
  return request<TopStocksSnapshot | null>("/api/top-stocks", { signal });
}

export function replaceTopStocks(source: TopStocksSource) {
  return request<TopStocksSnapshot>("/api/top-stocks", { method: "PUT", body: JSON.stringify(source) });
}

export function refreshTopStocks() {
  return request<TopStocksSnapshot | null>("/api/top-stocks/refresh", { method: "POST" });
}

export function clearTopStocks() {
  return request<void>("/api/top-stocks", { method: "DELETE" });
}

export function fetchTopStockScreens(signal?: AbortSignal) {
  return request<TopStockScreen[]>("/api/top-stock-screens", { signal });
}

export function createTopStockScreen(input: TopStockScreenInput) {
  return request<TopStockScreen>("/api/top-stock-screens", { method: "POST", body: JSON.stringify(input) });
}

export function updateTopStockScreen(id: number, input: TopStockScreenInput) {
  return request<TopStockScreen>(`/api/top-stock-screens/${id}`, { method: "PUT", body: JSON.stringify(input) });
}

export function deleteTopStockScreen(id: number) {
  return request<void>(`/api/top-stock-screens/${id}`, { method: "DELETE" });
}
