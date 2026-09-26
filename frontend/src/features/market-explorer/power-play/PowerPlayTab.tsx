import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Button, CircularProgress, Typography } from "@mui/material";
import {
  fetchMarketExplorerPowerPlay,
  type PowerPlayResult,
  type PowerPlaySettings,
} from "../../../api/marketExplorer";
import { Toast } from "../../../components/Toast";
import { TickerLens } from "../../ticker-lens/TickerLens";
import type { TickerMetric } from "../../ticker-lens/types";
import { CheckboxDropdown } from "../components/CheckboxDropdown";
import { DollarVolumeSlider } from "../components/DollarVolumeSlider";
import { SteppedSlider } from "../components/SteppedSlider";
import { useMarketExplorerGroupFilters } from "../components/useMarketExplorerGroupFilters";
import { clearCommonFilter, readCommonDollarVolume, writeCommonFilter } from "../components/commonFilterStorage";
import "./power-play-tab.css";

const storagePrefix = "market-watch.market-explorer.power-play.";
const defaults: PowerPlaySettings = {
  lookbackMonths: 3,
  limit: 100,
  minimumDollarVolume: 0,
};
const defaultMetricSort = { metricId: "power-play-gain", direction: "desc" } as const;

export function PowerPlayTab({ toolbarContainer }: { toolbarContainer: HTMLElement | null }) {
  const [settings, setSettings] = useState(readSettings);
  const [result, setResult] = useState<PowerPlayResult>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const groupFilters = useMarketExplorerGroupFilters();
  const requestSettings = useMemo<PowerPlaySettings>(() => ({
    ...settings,
    ...groupFilters.selection,
  }), [groupFilters.selection, settings]);

  useEffect(() => {
    if (!groupFilters.ready) return;
    const controller = new AbortController();
    fetchMarketExplorerPowerPlay(requestSettings, controller.signal)
      .then((next) => {
        if (!controller.signal.aborted) setResult(next);
      })
      .catch((requestError: unknown) => {
        if (requestError instanceof Error && requestError.name !== "AbortError") {
          setError(requestError.message);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [groupFilters.ready, requestSettings]);

  const update = <Key extends keyof PowerPlaySettings>(
    key: Key,
    value: PowerPlaySettings[Key],
  ) => {
    if (key === "minimumDollarVolume") writeCommonFilter("minimumDollarVolume", String(value));
    else localStorage.setItem(`${storagePrefix}${key}`, String(value));
    if (settings[key] === value) return;
    setError(undefined);
    setLoading(true);
    setSettings((current) => ({ ...current, [key]: value }));
  };
  const eventsBySymbol = useMemo(
    () => new Map(result?.events.map((event) => [event.symbol, event]) ?? []),
    [result],
  );
  const metrics = useMemo<readonly TickerMetric[]>(() => [{
    id: "power-play-gain",
    label: "GAIN",
    values: new Map(result?.events.map((event) => [event.symbol, event.return_percent]) ?? []),
    formatValue: (value) => `+${value.toFixed(0)}%`,
    tooltipLines: (symbol) => {
      const event = eventsBySymbol.get(symbol);
      return event === undefined ? [] : [
        `${event.start_date} → ${event.end_date} · ${event.elapsed_days} days`,
        `$${event.start_close.toFixed(2)} → $${event.end_close.toFixed(2)}`,
      ];
    },
  }], [eventsBySymbol, result]);
  const symbols = result?.events.map((event) => event.symbol) ?? [];
  const busy = groupFilters.loading || (groupFilters.ready && loading);
  const resetFilters = () => {
    for (const key of ["lookbackMonths", "limit"]) {
      localStorage.removeItem(`${storagePrefix}${key}`);
    }
    clearCommonFilter("minimumDollarVolume");
    groupFilters.reset();
    setSettings(defaults);
    setError(undefined);
    setLoading(true);
  };

  return (
    <section className="market-explorer-power-play" aria-label="Power Play">
      {toolbarContainer !== null && createPortal(
        <div className="market-explorer-power-play-controls">
          {result !== undefined && (
            <Typography className="market-explorer-power-play-summary">
              {result.events.length} tickers · through {result.as_of}
            </Typography>
          )}
          <CheckboxDropdown
            label="Industries"
            options={groupFilters.industryOptions}
            selectedValues={groupFilters.selectedIndustryKeys}
            onCommit={(selected) => {
              groupFilters.commitIndustrySelection(selected);
              setError(undefined);
              setLoading(true);
            }}
          />
          <CheckboxDropdown
            label="Themes"
            options={groupFilters.themeOptions}
            selectedValues={groupFilters.selectedThemeIds}
            onCommit={(selected) => {
              groupFilters.commitThemeSelection(selected);
              setError(undefined);
              setLoading(true);
            }}
          />
          <DollarVolumeSlider
            value={settings.minimumDollarVolume}
            onCommit={(value) => update("minimumDollarVolume", value)}
          />
          <SteppedSlider
            label="Lookback"
            value={settings.lookbackMonths}
            minimum={1}
            maximum={12}
            step={1}
            formatValue={(value) => value === 12 ? "1Y" : `${value}M`}
            onCommit={(value) => update("lookbackMonths", value)}
          />
          <SteppedSlider
            label="Result count"
            value={settings.limit}
            minimum={50}
            maximum={500}
            step={50}
            onCommit={(value) => update("limit", value)}
          />
          <Button className="market-explorer-filter-reset" size="small" onClick={resetFilters}>
            Reset
          </Button>
          <span className="market-explorer-power-play-loading" aria-hidden={!busy}>
            {busy && <CircularProgress size="0.8rem" />}
          </span>
        </div>,
        toolbarContainer,
      )}
      {result === undefined ? (
        <div className="panel-status">
          {busy && <CircularProgress size="1rem" />}
        </div>
      ) : symbols.length === 0 ? (
        <div className="panel-status">
          <Typography color="text.secondary">No qualifying Power Play results</Typography>
        </div>
      ) : (
        <TickerLens
          accent="green"
          universe={{ type: "bounded", symbols }}
          metrics={metrics}
          defaultMetricSort={defaultMetricSort}
        />
      )}
      <Toast
        message={error ?? groupFilters.error}
        onClose={() => {
          setError(undefined);
          groupFilters.clearError();
        }}
      />
    </section>
  );
}

function readSettings(): PowerPlaySettings {
  const storedLookback = Number(localStorage.getItem(`${storagePrefix}lookbackMonths`));
  const storedLimit = Number(localStorage.getItem(`${storagePrefix}limit`));
  return {
    lookbackMonths: Number.isInteger(storedLookback) && storedLookback >= 1 && storedLookback <= 12
      ? storedLookback : defaults.lookbackMonths,
    limit: Number.isInteger(storedLimit) && storedLimit >= 50 && storedLimit <= 500
      && storedLimit % 50 === 0 ? storedLimit : defaults.limit,
    minimumDollarVolume: readCommonDollarVolume(),
  };
}
