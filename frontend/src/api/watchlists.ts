export interface Watchlist {
  id: number;
  name: string;
  icon_key: string;
  is_default: boolean;
  ticker_count: number;
}

export interface WatchlistInput {
  name: string;
  icon_key: string;
}

export interface TickerWatchlists {
  symbol: string;
  watchlist_ids: number[];
}

const membershipBatchSize = 500;

export async function fetchWatchlists(signal?: AbortSignal): Promise<Watchlist[]> {
  return request("/api/watchlists", { signal });
}

export async function createWatchlist(input: WatchlistInput): Promise<Watchlist> {
  return request("/api/watchlists", { method: "POST", body: JSON.stringify(input) });
}

export async function updateWatchlist(id: number, input: WatchlistInput): Promise<Watchlist> {
  return request(`/api/watchlists/${id}`, { method: "PUT", body: JSON.stringify(input) });
}

export async function deleteWatchlist(id: number): Promise<void> {
  await request(`/api/watchlists/${id}`, { method: "DELETE" });
}

export async function fetchWatchlistSymbols(id: number, signal?: AbortSignal): Promise<string[]> {
  return request(`/api/watchlists/${id}/tickers`, { signal });
}

export async function fetchTickerWatchlists(symbols: string[], signal?: AbortSignal): Promise<TickerWatchlists[]> {
  if (symbols.length === 0) return [];
  const requests: Promise<TickerWatchlists[]>[] = [];
  for (let start = 0; start < symbols.length; start += membershipBatchSize) {
    requests.push(request("/api/watchlists/memberships", {
      method: "POST",
      body: JSON.stringify({ symbols: symbols.slice(start, start + membershipBatchSize) }),
      signal,
    }));
  }
  return (await Promise.all(requests)).flat();
}

export async function addTickerToWatchlist(id: number, symbol: string): Promise<void> {
  await request(`/api/watchlists/${id}/tickers/${encodeURIComponent(symbol)}`, { method: "PUT" });
}

export async function removeTickerFromWatchlist(id: number, symbol: string): Promise<void> {
  await request(`/api/watchlists/${id}/tickers/${encodeURIComponent(symbol)}`, { method: "DELETE" });
}

export async function clearTickerWatchlists(symbol: string): Promise<void> {
  await request(`/api/watchlists/tickers/${encodeURIComponent(symbol)}`, { method: "DELETE" });
}

async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: init.body === undefined ? init.headers : { "Content-Type": "application/json", ...init.headers },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(body?.error ?? `Watchlist request failed: HTTP ${response.status}`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}
