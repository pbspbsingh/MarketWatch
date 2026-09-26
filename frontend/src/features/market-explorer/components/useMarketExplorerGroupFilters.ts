import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchIndustries } from "../../../api/industries";
import { fetchThemes } from "../../../api/themes";
import { clearCommonFilter, readCommonFilter, writeCommonFilter } from "./commonFilterStorage";

export type MarketExplorerFilterOption<Value extends string | number> = {
  value: Value;
  label: string;
  group?: string;
};

export type MarketExplorerGroupSelection = {
  industryKeys?: string[];
  themeIds?: number[];
};

export function useMarketExplorerGroupFilters() {
  const [industryOptions, setIndustryOptions] = useState<MarketExplorerFilterOption<string>[]>([]);
  const [themeOptions, setThemeOptions] = useState<MarketExplorerFilterOption<number>[]>([]);
  const [excludedIndustryKeys, setExcludedIndustryKeys] = useState(
    () => readStoredSet<string>("excludedIndustryKeys", isString),
  );
  const [excludedThemeIds, setExcludedThemeIds] = useState(
    () => readStoredSet<number>("excludedThemeIds", isNumber),
  );
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([fetchIndustries(controller.signal), fetchThemes(controller.signal)])
      .then(([industries, themes]) => {
        if (controller.signal.aborted) return;
        const nextIndustryOptions = industries
          .map(({ key, name, sector_name }) => ({
            value: key,
            label: name,
            group: sector_name ?? "Unclassified",
          }))
          .sort(compareOptions);
        const nextThemeOptions = themes
          .map(({ id, name }) => ({ value: id, label: name }))
          .sort(compareOptions);
        setIndustryOptions(nextIndustryOptions);
        setThemeOptions(nextThemeOptions);
        setExcludedIndustryKeys((current) => retainKnown(current, nextIndustryOptions));
        setExcludedThemeIds((current) => retainKnown(current, nextThemeOptions));
        setLoaded(true);
        setLoading(false);
      })
      .catch((requestError: unknown) => {
        if (requestError instanceof Error && requestError.name !== "AbortError") {
          setError(requestError.message);
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, []);

  const selectedIndustryKeys = useMemo(
    () => selectedValues(industryOptions, excludedIndustryKeys),
    [excludedIndustryKeys, industryOptions],
  );
  const selectedThemeIds = useMemo(
    () => selectedValues(themeOptions, excludedThemeIds),
    [excludedThemeIds, themeOptions],
  );
  const selection = useMemo<MarketExplorerGroupSelection>(() => ({
    industryKeys: selectedIndustryKeys.size === industryOptions.length
      ? undefined
      : [...selectedIndustryKeys],
    themeIds: selectedThemeIds.size === themeOptions.length ? undefined : [...selectedThemeIds],
  }), [industryOptions.length, selectedIndustryKeys, selectedThemeIds, themeOptions.length]);
  const commitIndustrySelection = useCallback((selected: Set<string>) => {
    const excluded = excludedValues(industryOptions, selected);
    storeSet("excludedIndustryKeys", excluded);
    setExcludedIndustryKeys(excluded);
  }, [industryOptions]);
  const commitThemeSelection = useCallback((selected: Set<number>) => {
    const excluded = excludedValues(themeOptions, selected);
    storeSet("excludedThemeIds", excluded);
    setExcludedThemeIds(excluded);
  }, [themeOptions]);
  const reset = useCallback(() => {
    clearCommonFilter("excludedIndustryKeys");
    clearCommonFilter("excludedThemeIds");
    setExcludedIndustryKeys(new Set());
    setExcludedThemeIds(new Set());
  }, []);

  return {
    industryOptions,
    themeOptions,
    selectedIndustryKeys,
    selectedThemeIds,
    selection,
    loading,
    ready: loaded && error === undefined,
    error,
    clearError: () => setError(undefined),
    commitIndustrySelection,
    commitThemeSelection,
    reset,
  };
}

function compareOptions<Value extends string | number>(
  left: MarketExplorerFilterOption<Value>,
  right: MarketExplorerFilterOption<Value>,
) {
  return (left.group ?? "").localeCompare(right.group ?? "")
    || left.label.localeCompare(right.label);
}

function selectedValues<Value extends string | number>(
  options: ReadonlyArray<MarketExplorerFilterOption<Value>>,
  excluded: ReadonlySet<Value>,
) {
  return new Set(options.map((option) => option.value).filter((value) => !excluded.has(value)));
}

function excludedValues<Value extends string | number>(
  options: ReadonlyArray<MarketExplorerFilterOption<Value>>,
  selected: ReadonlySet<Value>,
) {
  return new Set(options.map((option) => option.value).filter((value) => !selected.has(value)));
}

function retainKnown<Value extends string | number>(
  values: ReadonlySet<Value>,
  options: ReadonlyArray<MarketExplorerFilterOption<Value>>,
) {
  const known = new Set(options.map((option) => option.value));
  return new Set([...values].filter((value) => known.has(value)));
}

function readStoredSet<Value extends string | number>(
  key: "excludedIndustryKeys" | "excludedThemeIds",
  valid: (value: unknown) => value is Value,
) {
  try {
    const stored = JSON.parse(readCommonFilter(key) ?? "[]") as unknown;
    return new Set(Array.isArray(stored) ? stored.filter(valid) : []);
  } catch {
    return new Set<Value>();
  }
}

function storeSet<Value extends string | number>(
  key: "excludedIndustryKeys" | "excludedThemeIds",
  values: ReadonlySet<Value>,
) {
  writeCommonFilter(key, JSON.stringify([...values]));
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}
