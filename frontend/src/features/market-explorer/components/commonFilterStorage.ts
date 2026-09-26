type CommonFilterKey = "excludedIndustryKeys" | "excludedThemeIds" | "minimumDollarVolume";

const sharedPrefix = "market-watch.market-explorer.common.";

export function readCommonFilter(key: CommonFilterKey): string | null {
  return localStorage.getItem(`${sharedPrefix}${key}`);
}

export function writeCommonFilter(key: CommonFilterKey, value: string): void {
  localStorage.setItem(`${sharedPrefix}${key}`, value);
}

export function clearCommonFilter(key: CommonFilterKey): void {
  localStorage.removeItem(`${sharedPrefix}${key}`);
}

export function readCommonDollarVolume(): number {
  const stored = readCommonFilter("minimumDollarVolume");
  if (stored === null) return 0;
  const value = Number(stored);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}
