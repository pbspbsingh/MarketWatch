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

export type MatchRange = [number, number];

export interface TickerSearchMatch {
  symbolRanges: MatchRange[];
  nameRanges: MatchRange[];
  score: number;
}

function findToken(label: string, token: string, used: MatchRange[] = []): MatchRange | undefined {
  let start = label.indexOf(token);
  while (start >= 0) {
    const end = start + token.length;
    if (!used.some(([usedStart, usedEnd]) => start < usedEnd && end > usedStart)) {
      return [start, end];
    }
    start = label.indexOf(token, start + 1);
  }
  return undefined;
}

function mergeRanges(ranges: MatchRange[]): MatchRange[] {
  const sorted = ranges.sort((left, right) => left[0] - right[0]);
  const merged: MatchRange[] = [];
  for (const [start, end] of sorted) {
    const last = merged.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

export function matchThemeTicker(ticker: ThemeTicker, search: string): TickerSearchMatch | undefined {
  const query = search.trim().toLocaleLowerCase();
  if (!query) return { symbolRanges: [], nameRanges: [], score: 0 };

  const symbol = ticker.symbol.toLocaleLowerCase();
  const name = ticker.name?.toLocaleLowerCase() ?? "";
  const symbolPhrase = findToken(symbol, query);
  const namePhrase = findToken(name, query);
  if (symbolPhrase || namePhrase) {
    return {
      symbolRanges: symbolPhrase ? [symbolPhrase] : [],
      nameRanges: namePhrase ? [namePhrase] : [],
      score: symbolPhrase
        ? symbol === query ? 0 : symbolPhrase[0] === 0 ? 10 : 20
        : name === query ? 30 : namePhrase?.[0] === 0 ? 40 : 50,
    };
  }

  // Each word may match either the symbol or the company name, in any order.
  const tokens = query.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (tokens.length < 2) return undefined;
  const symbolRanges: MatchRange[] = [];
  const nameRanges: MatchRange[] = [];
  let score = 100;
  for (const token of tokens) {
    const symbolRange = findToken(symbol, token, symbolRanges);
    const nameRange = findToken(name, token, nameRanges);
    if (!symbolRange && !nameRange) return undefined;
    if (symbolRange) {
      symbolRanges.push(symbolRange);
      score += symbolRange[0];
    }
    if (nameRange) {
      nameRanges.push(nameRange);
      score += 20 + nameRange[0];
    }
  }
  return { symbolRanges: mergeRanges(symbolRanges), nameRanges: mergeRanges(nameRanges), score };
}

export function filterThemeTickers(
  tickers: ThemeTicker[],
  search: string,
  selectedIndustryKeys: Set<string>,
  unassignedOnly: boolean,
  unprocessedOnly: boolean,
): ThemeTicker[] {
  const results: Array<{ ticker: ThemeTicker; score: number }> = [];
  for (const ticker of tickers) {
    if (unassignedOnly && ticker.assignments.length > 0) continue;
    if (unprocessedOnly && ticker.automatic_processed) continue;
    if (!matchesIndustryFilter(ticker, selectedIndustryKeys)) continue;
    const match = matchThemeTicker(ticker, search);
    if (match) results.push({ ticker, score: match.score });
  }
  if (search.trim()) results.sort((left, right) => left.score - right.score);
  return results.map(({ ticker }) => ticker);
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

export function enrichTickers(
  symbols: string[],
  onError: (message: string) => void,
  onSettled: () => void,
) {
  if (symbols.length === 0) return;
  void Promise.allSettled(symbols.map(addThemeTicker)).then((results) => {
    const failures = results.filter((result) => result.status === "rejected");
    if (failures.length > 0) {
      const count = `${failures.length} ticker${failures.length === 1 ? "" : "s"}`;
      onError(`${count} failed to load: ${errorMessage(failures[0].reason)}`);
    }
    onSettled();
  });
}

export function jobStatusColor(
  status: ThemeAiJob["status"],
): "default" | "info" | "success" | "warning" | "error" {
  if (status === "pending" || status === "running") return "info";
  if (status === "completed" || status === "applied") return "success";
  if (status === "failed") return "error";
  if (status === "partially_failed") return "warning";
  return "default";
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unexpected error";
}
