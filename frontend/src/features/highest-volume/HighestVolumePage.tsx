import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { CircularProgress, Slider, TextField, Typography } from "@mui/material";
import {
  fetchHighestVolume,
  type HighestVolumeLimit,
  type HighestVolumeLookback,
  type HighestVolumeResult,
  type HighestVolumeScanRange,
  type HighestVolumeSettings,
} from "../../api/highestVolume";
import { Toast } from "../../components/Toast";
import { TickerLens } from "../ticker-lens/TickerLens";
import type { TickerMetric } from "../ticker-lens/types";
import "./highest-volume.css";

const storagePrefix = "market-watch.highest-volume.";
const defaults: HighestVolumeSettings = {
  scanRange: "month1",
  lookback: "year1",
  limit: 100,
  minimumRvol: 2,
  minimumRangeAtr: 1,
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

export function HighestVolumePage() {
  const [settings, setSettings] = useState(readSettings);
  const [result, setResult] = useState<HighestVolumeResult>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  useEffect(() => {
    const controller = new AbortController();
    fetchHighestVolume(settings, controller.signal)
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
    setResult(undefined);
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
    <section className="workspace-panel highest-volume-page" aria-label="Highest Volume">
      <header className="panel-header highest-volume-header">
        <Typography component="h1">Highest Volume</Typography>
        <div className="highest-volume-controls">
          {loading && <CircularProgress size="0.8rem" />}
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
          {result !== undefined && (
            <Typography className="highest-volume-summary">
              {result.events.length} events · {result.as_of}
            </Typography>
          )}
        </div>
      </header>
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

function DiscreteSlider<Value extends string | number>({
  label,
  options,
  value,
  onCommit,
}: {
  label: string;
  options: ReadonlyArray<{ value: Value; label: string }>;
  value: Value;
  onCommit: (value: Value) => void;
}) {
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value));
  const [draftIndex, setDraftIndex] = useState(selectedIndex);
  const indexValue = (next: number | number[]) => Array.isArray(next) ? next[0] : next;

  return (
    <label className="highest-volume-slider">
      <Typography component="span">{label}</Typography>
      <Slider
        size="small"
        min={0}
        max={options.length - 1}
        step={1}
        marks
        value={draftIndex}
        valueLabelDisplay="auto"
        valueLabelFormat={(index) => options[index]?.label ?? ""}
        aria-label={label}
        onChange={(_, next) => setDraftIndex(indexValue(next))}
        onChangeCommitted={(_, next) => {
          const option = options[indexValue(next)];
          if (option !== undefined) onCommit(option.value);
        }}
      />
      <Typography component="span">{options[draftIndex]?.label}</Typography>
    </label>
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
    <label className="highest-volume-number">
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
