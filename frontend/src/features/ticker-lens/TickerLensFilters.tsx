import { useEffect, useMemo, useRef, useState } from "react";
import KeyboardArrowDownIcon from "@mui/icons-material/KeyboardArrowDown";
import KeyboardArrowUpIcon from "@mui/icons-material/KeyboardArrowUp";
import NavigateNextIcon from "@mui/icons-material/NavigateNext";
import PushPinIcon from "@mui/icons-material/PushPin";
import PushPinOutlinedIcon from "@mui/icons-material/PushPinOutlined";
import RestartAltIcon from "@mui/icons-material/RestartAlt";
import { Checkbox, IconButton, Slider, Tooltip, Typography } from "@mui/material";
import type { TickerFilterCounts, TickerFilters } from "./types";
import { formatVolume } from "./utils";

import { createDefaultTickerFilters } from "./tickerLensPreferences";

interface TickerLensFiltersProps {
  filters: TickerFilters;
  enabled: boolean;
  persisted: boolean;
  counts: TickerFilterCounts;
  onChange: (filters: TickerFilters) => void;
  onPersistedChange: (persisted: boolean) => void;
}

export function TickerLensFilters({ filters, enabled, persisted, counts, onChange, onPersistedChange }: TickerLensFiltersProps) {
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  const restoreToggleFocus = useRef(false);
  const activeCount = Number(filters.adr.enabled) + Number(filters.dollarVolume.enabled)
    + Number(filters.above200Sma.enabled);
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
      restoreToggleFocus.current = false;
      setOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [open]);

  useEffect(() => {
    if (!open && wasOpen.current && restoreToggleFocus.current) toggleRef.current?.focus();
    if (!open) restoreToggleFocus.current = false;
    wasOpen.current = open;
  }, [open]);

  return (
    <>
      {!open && (
      <Tooltip title={effective
        ? `${activeCount} active ticker filter${activeCount === 1 ? "" : "s"}`
        : pending
          ? "Select a group to apply ticker filters"
          : "Ticker filters"}>
        <IconButton
          ref={toggleRef}
          className={[
            "ticker-lens-filter-toggle",
            effective ? "ticker-lens-filter-toggle-active" : "",
            pending ? "ticker-lens-filter-toggle-pending" : "",
          ].filter(Boolean).join(" ")}
          size="small"
          aria-label="Open ticker filters"
          onClick={() => {
            restoreToggleFocus.current = false;
            setOpen(true);
          }}
        >
          <KeyboardArrowDownIcon fontSize="small" />
          {active && (
            <span className="ticker-lens-filter-toggle-count">{counts.total}</span>
          )}
        </IconButton>
      </Tooltip>
      )}
      <section
        ref={panelRef}
        className={[
          "ticker-lens-filters",
          open ? "ticker-lens-filters-open" : "",
          effective ? "ticker-lens-filters-active" : "",
          pending ? "ticker-lens-filters-pending" : "",
        ].filter(Boolean).join(" ")}
        aria-label="Ticker filters"
        aria-hidden={!open}
        inert={!open}
      >
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
          <Tooltip title={persisted ? "Stop persisting filter state" : "Persist filter state"}>
            <IconButton
              size="small"
              aria-label={persisted ? "Stop persisting filter state" : "Persist filter state"}
              className={persisted ? "ticker-lens-filter-pin-active" : undefined}
              onClick={() => onPersistedChange(!persisted)}
            >
              {persisted ? <PushPinIcon fontSize="small" /> : <PushPinOutlinedIcon fontSize="small" />}
            </IconButton>
          </Tooltip>
          <Tooltip title="Reset filters">
            <span>
              <IconButton
                size="small"
                disabled={!active && !hasValues}
                aria-label="Reset ticker filters"
                onClick={() => onChange(createDefaultTickerFilters())}
              >
                <RestartAltIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
          <Tooltip title="Collapse filters">
            <IconButton
              size="small"
              aria-label="Collapse ticker filters"
              onClick={() => {
                restoreToggleFocus.current = true;
                setOpen(false);
              }}
            >
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
      <label className={[
        "ticker-lens-filter-checkbox",
        filters.above200Sma.enabled && enabled ? "ticker-lens-filter-slider-active" : "",
        filters.above200Sma.enabled && !enabled ? "ticker-lens-filter-slider-pending" : "",
      ].filter(Boolean).join(" ")}>
        <Checkbox
          size="small"
          checked={filters.above200Sma.enabled}
          slotProps={{ input: { "aria-label": "Enable 200SMA filter" } }}
          onChange={(event) => onChange({ ...filters, above200Sma: { enabled: event.target.checked } })}
        />
        <Typography component="span">Close &gt; 200SMA</Typography>
      </label>
      </section>
    </>
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

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}
