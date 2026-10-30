import { queryOptions, skipToken, type QueryClient } from "@tanstack/react-query";
import { marketDataSymbol, type MarketChartInterval } from "../../api/marketChart";
import { fetchLastStudy, fetchStudy, type StudyResult } from "../../api/study";
import { shiftYears } from "./studyDates";

export interface StudySelection {
  symbols: [string, string];
  date: string;
  range?: { start: string; end: string };
  fetchRange?: { start: string; end: string };
}
export interface StudyRequest extends StudySelection {
  interval: MarketChartInterval;
  period: number;
}

export function studySelection(result: StudyResult): StudySelection {
  return { symbols: [result.series[0].symbol, result.series[1].symbol], date: result.date,
    range: { start: result.range_start, end: result.range_end } };
}

export function studyScope(request: StudySelection) {
  return ["study", marketDataSymbol(request.symbols[0]), marketDataSymbol(request.symbols[1]), request.date] as const;
}
export function studyQueryKey(request: StudyRequest) {
  return [...studyScope(request), request.interval, request.period, request.range?.start ?? null, request.range?.end ?? null] as const;
}
function matchesSelection(result: StudyResult, request: StudySelection) {
  return result.date === request.date && result.series[0]?.symbol === marketDataSymbol(request.symbols[0])
    && result.series[1]?.symbol === marketDataSymbol(request.symbols[1]);
}
function matchesPeriod(result: StudyResult, request: StudyRequest) {
  return result.interval === request.interval && (result.relative_strength === null
    || result.relative_strength.line.moving_average_period === request.period);
}
function checkResult(result: StudyResult, request: StudyRequest) {
  if (!Array.isArray(result.series) || result.series.length !== 2 || !matchesSelection(result, request)
    || !matchesPeriod(result, request)
    || (result.relative_strength !== null && result.relative_strength.comparison_symbol !== marketDataSymbol(request.symbols[1]))
    || !(result.range_start < result.range_end)
    || (request.range !== undefined && (result.range_start !== request.range.start || result.range_end > request.range.end))) {
    throw new Error("Study response did not match the requested tickers, date, or settings");
  }
  return result;
}

function cachedResults(client: QueryClient, request: StudySelection) {
  return client.getQueriesData<StudyResult>({ queryKey: studyScope(request) })
    .map(([, value]) => value).filter((value): value is StudyResult => value !== undefined && matchesSelection(value, request));
}

export function studyPlaceholder(result: StudyResult | undefined, request: StudyRequest | undefined) {
  if (result === undefined || request === undefined || !matchesSelection(result, request)) return undefined;
  return matchesPeriod(result, request) ? result : { ...result, relative_strength: null };
}

export function displayedStudyResult(client: QueryClient, request: StudyRequest | undefined, result?: StudyResult) {
  if (request === undefined) return undefined;
  if (result !== undefined) return studyPlaceholder(result, request);
  const candidates = cachedResults(client, request);
  candidates.sort((a, b) => Number(b.interval === request.interval) - Number(a.interval === request.interval)
    || a.range_start.localeCompare(b.range_start) || b.range_end.localeCompare(a.range_end));
  return studyPlaceholder(candidates[0], request);
}

export function studyQueryOptions(client: QueryClient, request: StudyRequest | undefined) {
  const queryKey: readonly unknown[] = request === undefined ? ["study", "unselected"] : studyQueryKey(request);
  return queryOptions({
    queryKey,
    meta: { priceSymbols: request?.symbols.map(marketDataSymbol) ?? [] },
    staleTime: 0,
    queryFn: request === undefined ? skipToken : async ({ signal }) => {
      const refresh = client.getQueryState(studyQueryKey(request))?.isInvalidated === true;
      // Smoothing and interval changes reuse the full loaded range. Fetch only an
      // additional history segment when that range is not already in the cache.
      const range = request.range;
      const loadedRange = range !== undefined && cachedResults(client, request).some(result =>
        result.range_start <= range.start && result.range_end >= range.end);
      const symbols: [string, string] = [marketDataSymbol(request.symbols[0]), marketDataSymbol(request.symbols[1])];
      const result = await fetchStudy(symbols, request.date, request.interval,
        { range: request.range, fetchRange: refresh || loadedRange ? undefined : request.fetchRange,
          refresh, relativeStrengthPeriod: request.period, signal });
      return checkResult(result, request);
    },
  });
}

export function restoreStudyQueryOptions(client: QueryClient, interval: MarketChartInterval, period: number) {
  return queryOptions({
    queryKey: ["study-restore", interval, period],
    staleTime: 0,
    queryFn: async ({ signal }) => {
      const result = await fetchLastStudy(interval, signal, period);
      signal.throwIfAborted();
      if (result !== null) {
        if (!Array.isArray(result.series) || result.series.length !== 2) throw new Error("Invalid saved Study");
        const request = { ...studySelection(result), interval, period };
        checkResult(result, request);
        const options = studyQueryOptions(client, request);
        const invalidated = client.getQueryCache().findAll({ queryKey: studyScope(request) })
          .some(query => query.state.isInvalidated);
        client.getQueryCache().build<StudyResult>(client, options);
        if (invalidated) {
          // The backend's saved Study can outlive a price-cache clear. Keep the
          // invalidation so the active query reloads prices instead of reviving it.
          await client.invalidateQueries({ queryKey: studyQueryKey(request), exact: true, refetchType: "none" });
        } else client.setQueryData(studyQueryKey(request), result);
      }
      return result;
    },
  });
}

export function expandedStudySelection(result: StudyResult, direction: "before" | "after"): StudySelection | undefined {
  if (direction === "before" ? !result.has_more_before : !result.has_more_after) return undefined;
  const range = direction === "before"
    ? { start: shiftYears(result.range_start, -1), end: result.range_end }
    : { start: result.range_start, end: shiftYears(result.range_end, 1) };
  return { ...studySelection(result), range, fetchRange: direction === "before"
    ? { start: range.start, end: result.range_start } : { start: result.range_end, end: range.end } };
}
