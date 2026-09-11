import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { CircularProgress, TextField, Typography } from "@mui/material";
import {
  fetchMarketExplorerHighestVolume,
  type HighestVolumeLimit,
  type HighestVolumeLookback,
  type HighestVolumeResult,
  type HighestVolumeScanRange,
  type HighestVolumeSettings,
} from "../../../api/marketExplorer";
import { Toast } from "../../../components/Toast";
import { TickerLens } from "../../ticker-lens/TickerLens";
import type { TickerMetric } from "../../ticker-lens/types";
import { DiscreteSlider } from "../components/DiscreteSlider";
import { DollarVolumeSlider } from "../components/DollarVolumeSlider";
import "./highest-volume-tab.css";

const storagePrefix = "market-watch.market-explorer.highest-volume.";
const defaults: HighestVolumeSettings = {
  scanRange: "month1",
  lookback: "year1",
  limit: 100,
  minimumRvol: 2,
  minimumRangeAtr: 1,
  minimumDollarVolume: 0,
};
const scanRanges: ReadonlyArray<{ value: HighestVolumeScanRange; label: string }> = [
  { value: "month1", label: "1M" },
  { value: "months3", label: "3M" },
  { value: "months6", label: "6M" },
];
const lookbacks: ReadonlyArray<{ value: HighestVolumeLookback; label: string }> = [
  { value: "months3", label: "3M" },
  { value: "months6", label: "6M" },
  { value: "year1", label: "1Y" },
  { value: "years2", label: "2Y" },
];
const limits: ReadonlyArray<{ value: HighestVolumeLimit; label: string }> = [
  { value: 25, label: "25" },
  { value: 50, label: "50" },
  { value: 100, label: "100" },
  { value: 250, label: "250" },
];
const defaultMetricSort = { metricId: "event-score", direction: "desc" } as const;

export function HighestVolumeTab({ toolbarContainer }: { toolbarContainer: HTMLElement | null }) {
  const [settings, setSettings] = useState(readSettings);
  const [result, setResult] = useState<HighestVolumeResult>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  useEffect(() => {
    const controller = new AbortController();
    fetchMarketExplorerHighestVolume(settings, controller.signal)
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
  }, [settings]);

  const update = <Key extends keyof HighestVolumeSettings>(
    key: Key,
    value: HighestVolumeSettings[Key],
  ) => {
    localStorage.setItem(`${storagePrefix}${key}`, String(value));
    if (settings[key] === value) return;
    setError(undefined);
    setLoading(true);
    setSettings((current) => ({ ...current, [key]: value }));
  };
  const metrics = useMemo<readonly TickerMetric[]>(() => {
    const values = new Map(result?.events.map((event) => [event.symbol, event.rvol]) ?? []);
    return [{
      id: "event-score",
      label: "RVOL",
      values,
      formatValue: (value) => `${value.toFixed(2)}×`,
    }];
  }, [result]);
  const symbols = result?.events.map((event) => event.symbol) ?? [];

  return (
    <section className="market-explorer-highest-volume" aria-label="Highest Volume">
      {toolbarContainer !== null && createPortal(
        <div className="market-explorer-highest-volume-controls">
          {result !== undefined && (
            <Typography className="market-explorer-highest-volume-summary">
              {result.events.length} events · {result.as_of}
            </Typography>
          )}
          <DollarVolumeSlider
            value={settings.minimumDollarVolume}
            onCommit={(value) => update("minimumDollarVolume", value)}
          />
          <NumberControl
            label="Min Range"
            value={settings.minimumRangeAtr}
            decimals={1}
            suffix="ATR"
            onCommit={(value) => update("minimumRangeAtr", value)}
          />
          <NumberControl
            label="Min RVOL"
            value={settings.minimumRvol}
            decimals={1}
            onCommit={(value) => update("minimumRvol", value)}
          />
          <DiscreteSlider
            label="Scan"
            options={scanRanges}
            value={settings.scanRange}
            onCommit={(value) => update("scanRange", value)}
          />
          <DiscreteSlider
            label="Lookback"
            options={lookbacks}
            value={settings.lookback}
            onCommit={(value) => update("lookback", value)}
          />
          <DiscreteSlider
            label="Results"
            options={limits}
            value={settings.limit}
            onCommit={(value) => update("limit", value)}
          />
          <span className="market-explorer-highest-volume-loading" aria-hidden={!loading}>
            {loading && <CircularProgress size="0.8rem" />}
          </span>
        </div>,
        toolbarContainer,
      )}
      {result === undefined ? (
        <div className="panel-status">
          {loading && <CircularProgress size="1rem" />}
        </div>
      ) : symbols.length === 0 ? (
        <div className="panel-status">
          <Typography color="text.secondary">No qualifying volume events</Typography>
        </div>
      ) : (
        <TickerLens
          accent="indigo"
          universe={{ type: "bounded", symbols }}
          metrics={metrics}
          defaultMetricSort={defaultMetricSort}
        />
      )}
      <Toast message={error} onClose={() => setError(undefined)} />
    </section>
  );
}

function NumberControl({
  label,
  value,
  decimals,
  suffix,
  onCommit,
}: {
  label: string;
  value: number;
  decimals?: number;
  suffix?: string;
  onCommit: (value: number) => void;
}) {
  const format = (number: number) => decimals === undefined ? String(number) : number.toFixed(decimals);
  const [draft, setDraft] = useState(format(value));
  const commit = () => {
    const parsed = Number(draft);
    if (Number.isFinite(parsed) && parsed >= 0) {
      setDraft(format(parsed));
      onCommit(parsed);
    } else {
      setDraft(format(value));
    }
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commit();
    }
  };

  return (
    <label className="market-explorer-highest-volume-number">
      <Typography component="span">{label}</Typography>
      <TextField
        size="small"
        type="number"
        value={draft}
        slotProps={{ htmlInput: { min: 0, step: 0.25, "aria-label": label } }}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={handleKeyDown}
      />
      {suffix !== undefined && <Typography component="span">{suffix}</Typography>}
    </label>
  );
}

function readSettings(): HighestVolumeSettings {
  return {
    scanRange: readOption("scanRange", scanRanges, defaults.scanRange),
    lookback: readOption("lookback", lookbacks, defaults.lookback),
    limit: readOption("limit", limits, defaults.limit),
    minimumRvol: readNumber("minimumRvol", defaults.minimumRvol),
    minimumRangeAtr: readNumber("minimumRangeAtr", defaults.minimumRangeAtr),
    minimumDollarVolume: readNumber("minimumDollarVolume", defaults.minimumDollarVolume),
  };
}

function readOption<Value extends string | number>(
  key: string,
  options: ReadonlyArray<{ value: Value }>,
  fallback: Value,
) {
  const stored = localStorage.getItem(`${storagePrefix}${key}`);
  const option = options.find((item) => String(item.value) === stored);
  return option?.value ?? fallback;
}

function readNumber(key: string, fallback: number) {
  const stored = localStorage.getItem(`${storagePrefix}${key}`);
  if (stored === null) return fallback;
  const value = Number(stored);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}
