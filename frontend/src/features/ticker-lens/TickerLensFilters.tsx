import { useEffect, useMemo, useRef, useState } from "react";
import FilterListIcon from "@mui/icons-material/FilterList";
import KeyboardArrowDownIcon from "@mui/icons-material/KeyboardArrowDown";
import KeyboardArrowUpIcon from "@mui/icons-material/KeyboardArrowUp";
import NavigateNextIcon from "@mui/icons-material/NavigateNext";
import RestartAltIcon from "@mui/icons-material/RestartAlt";
import { Checkbox, IconButton, Slider, Tooltip, Typography } from "@mui/material";
import type { TickerFilterCounts, TickerFilters } from "./types";
import { formatVolume } from "./utils";

const filterValuesStorageKey = "market-watch.ticker-filter-values";

export const defaultTickerFilters: TickerFilters = {
  adr: {
    enabled: false,
    min: 0,
  },
  dollarVolume: {
    enabled: false,
    min: 0,
  },
};

export function readTickerFilters(): TickerFilters {
  const stored = localStorage.getItem(filterValuesStorageKey);
  if (stored === null) return defaultTickerFilters;
  try {
    const values = JSON.parse(stored) as { adrMin?: unknown; dollarVolumeMin?: unknown };
    return {
      adr: {
        enabled: false,
        min: validNumber(values.adrMin),
      },
      dollarVolume: {
        enabled: false,
        min: validNumber(values.dollarVolumeMin),
      },
    };
  } catch {
    return defaultTickerFilters;
  }
}

export function writeTickerFilterValues(filters: TickerFilters) {
  localStorage.setItem(filterValuesStorageKey, JSON.stringify({
    adrMin: filters.adr.min,
    dollarVolumeMin: filters.dollarVolume.min,
  }));
}

interface TickerLensFiltersProps {
  filters: TickerFilters;
  enabled: boolean;
  counts: TickerFilterCounts;
  onChange: (filters: TickerFilters) => void;
}

export function TickerLensFilters({ filters, enabled, counts, onChange }: TickerLensFiltersProps) {
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLElement>(null);
  const activeCount = Number(filters.adr.enabled) + Number(filters.dollarVolume.enabled);
  const active = activeCount > 0;
  const hasValues = filters.adr.min > 0 || filters.dollarVolume.min > 0;
  const effective = active && enabled;
  const pending = active && !enabled;
  const adrMin = clamp(filters.adr.min, 0, 20);
  const dollarVolumeMillions = useMemo(
    () => clamp(Math.round(filters.dollarVolume.min / 1_000_000), 0, 1_000),
    [filters.dollarVolume.min],
  );

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && panelRef.current?.contains(event.target)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [open]);

  if (!open) {
    return (
      <Tooltip title={effective
        ? `${activeCount} active ticker filter${activeCount === 1 ? "" : "s"}`
        : pending
          ? "Select a group to apply ticker filters"
          : "Ticker filters"}>
        <IconButton
          className={[
            "ticker-lens-filter-toggle",
            effective ? "ticker-lens-filter-toggle-active" : "",
            pending ? "ticker-lens-filter-toggle-pending" : "",
          ].filter(Boolean).join(" ")}
          size="small"
          aria-label="Open ticker filters"
          onClick={() => setOpen(true)}
        >
          {active ? <FilterListIcon fontSize="small" /> : <KeyboardArrowDownIcon fontSize="small" />}
        </IconButton>
      </Tooltip>
    );
  }

  return (
    <section ref={panelRef} className={[
      "ticker-lens-filters",
      effective ? "ticker-lens-filters-active" : "",
      pending ? "ticker-lens-filters-pending" : "",
    ].filter(Boolean).join(" ")} aria-label="Ticker filters">
      <div className="ticker-lens-filters-header">
        <Typography component="h3">Filters{active ? ` ${activeCount}` : ""}</Typography>
        <Typography className="ticker-lens-filter-count" component="span">
          (
          {counts.total}
          <NavigateNextIcon fontSize="inherit" />
          {counts.filtered}
          )
        </Typography>
        <div>
          <Tooltip title="Reset filters">
            <span>
              <IconButton
                size="small"
                disabled={!active && !hasValues}
                aria-label="Reset ticker filters"
                onClick={() => onChange(defaultTickerFilters)}
              >
                <RestartAltIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
          <Tooltip title="Collapse filters">
            <IconButton size="small" aria-label="Collapse ticker filters" onClick={() => setOpen(false)}>
              <KeyboardArrowUpIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </div>
      </div>
      <FilterSlider
        checked={filters.adr.enabled}
        active={filters.adr.enabled && enabled}
        pending={filters.adr.enabled && !enabled}
        label="ADR"
        value={adrMin}
        max={20}
        step={0.1}
        valueLabel={`${adrMin.toFixed(1)}%`}
        onCheckedChange={(checked) => onChange({ ...filters, adr: { ...filters.adr, enabled: checked } })}
        onChange={(value) => onChange({ ...filters, adr: { ...filters.adr, min: value } })}
      />
      <FilterSlider
        checked={filters.dollarVolume.enabled}
        active={filters.dollarVolume.enabled && enabled}
        pending={filters.dollarVolume.enabled && !enabled}
        label="DollarVol"
        value={dollarVolumeMillions}
        max={1_000}
        step={5}
        valueLabel={formatVolume(dollarVolumeMillions * 1_000_000)}
        onCheckedChange={(checked) => onChange({ ...filters, dollarVolume: { ...filters.dollarVolume, enabled: checked } })}
        onChange={(value) => onChange({ ...filters, dollarVolume: { ...filters.dollarVolume, min: value * 1_000_000 } })}
      />
    </section>
  );
}

function FilterSlider({
  checked,
  active,
  pending,
  label,
  value,
  max,
  step,
  valueLabel,
  onCheckedChange,
  onChange,
}: {
  checked: boolean;
  active: boolean;
  pending: boolean;
  label: string;
  value: number;
  max: number;
  step: number;
  valueLabel: string;
  onCheckedChange: (checked: boolean) => void;
  onChange: (value: number) => void;
}) {
  return (
    <label className={[
      "ticker-lens-filter-slider",
      active ? "ticker-lens-filter-slider-active" : "",
      pending ? "ticker-lens-filter-slider-pending" : "",
    ].filter(Boolean).join(" ")}>
      <span>
        <Checkbox
          size="small"
          checked={checked}
          slotProps={{ input: { "aria-label": `Enable ${label} filter` } }}
          onChange={(event) => onCheckedChange(event.target.checked)}
        />
        <Typography component="span">{label}</Typography>
        <Typography component="span">{valueLabel}</Typography>
      </span>
      <Slider
        size="small"
        min={0}
        max={max}
        step={step}
        value={value}
        valueLabelDisplay="auto"
        onChange={(_, nextValue) => onChange(Array.isArray(nextValue) ? nextValue[0] : nextValue)}
      />
    </label>
  );
}

function validNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}
