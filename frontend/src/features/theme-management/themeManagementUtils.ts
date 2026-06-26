import { addThemeTicker, type ThemeAiJob, type ThemeTicker, type ThemeTickerIndustry } from "../../api/themes";

export const unclassifiedIndustryKey = "__unclassified__";

export type IndustryFilterOption = ThemeTickerIndustry;

export function industryFilterOptions(
  industries: ThemeTickerIndustry[],
  tickers: ThemeTicker[],
): IndustryFilterOption[] {
  const options = new Map(industries.map((industry) => [industry.key, industry.name]));
  let hasUnclassified = false;
  for (const ticker of tickers) {
    if (ticker.industries.length === 0) hasUnclassified = true;
    for (const industry of ticker.industries) options.set(industry.key, industry.name);
  }
  if (hasUnclassified) options.set(unclassifiedIndustryKey, "No industry");
  return [...options]
    .map(([key, name]) => ({ key, name }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function matchesIndustryFilter(ticker: ThemeTicker, selectedIndustryKeys: Set<string>) {
  return ticker.industries.length === 0
    ? selectedIndustryKeys.has(unclassifiedIndustryKey)
    : ticker.industries.some((industry) => selectedIndustryKeys.has(industry.key));
}

export function sameData(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => sameData(value, right[index]))
    );
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  return (
    leftKeys.length === Object.keys(rightRecord).length &&
    leftKeys.every(
      (key) => Object.prototype.hasOwnProperty.call(rightRecord, key) && sameData(leftRecord[key], rightRecord[key]),
    )
  );
}

export function enrichTickers(symbols: string[], onError: (message: string) => void) {
  if (symbols.length === 0) return;
  void Promise.all(symbols.map(addThemeTicker)).catch((error: unknown) =>
    onError(errorMessage(error)),
  );
}

export function jobStatusColor(status: ThemeAiJob["status"]): "default" | "info" | "success" | "error" {
  if (status === "pending" || status === "running") return "info";
  if (status === "completed" || status === "applied") return "success";
  if (status === "failed") return "error";
  return "default";
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unexpected error";
}
