export async function fetchNextTradingDay(): Promise<string> {
  const response = await fetch("/api/market/next-trading-day");
  if (!response.ok) {
    throw new Error(`Failed to load next trading day: HTTP ${response.status}`);
  }
  return (await response.json() as { date: string }).date;
}
