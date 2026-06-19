export async function fetchFavourites(signal?: AbortSignal): Promise<string[]> {
  const response = await fetch("/api/watchlists/favourites", { signal });
  if (!response.ok) {
    throw new Error(`Failed to load favourites: HTTP ${response.status}`);
  }
  return response.json() as Promise<string[]>;
}

export async function addFavourite(symbol: string): Promise<void> {
  const response = await fetch(`/api/watchlists/favourites/${encodeURIComponent(symbol)}`, {
    method: "PUT",
  });
  if (!response.ok) {
    throw new Error(`Failed to add favourite: HTTP ${response.status}`);
  }
}

export async function removeFavourite(symbol: string): Promise<void> {
  const response = await fetch(`/api/watchlists/favourites/${encodeURIComponent(symbol)}`, {
    method: "DELETE",
  });
  if (!response.ok) {
    throw new Error(`Failed to remove favourite: HTTP ${response.status}`);
  }
}
