export function tradeIdFromSearch(searchParams: URLSearchParams): number | undefined {
  const value = searchParams.get("trade_id");
  return value !== null && /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value))
    ? Number(value) : undefined;
}
