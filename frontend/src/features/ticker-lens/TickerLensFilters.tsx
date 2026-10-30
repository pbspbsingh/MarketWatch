import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import KeyboardArrowDownIcon from "@mui/icons-material/KeyboardArrowDown";
import CloseIcon from "@mui/icons-material/Close";
import FilterAltIcon from "@mui/icons-material/FilterAlt";
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
  anchor: number | undefined;
  onAnchorChange: (anchor: number) => void;
}

export function TickerLensFilters({ filters, enabled, persisted, counts, onChange, onPersistedChange, anchor, onAnchorChange }: TickerLensFiltersProps) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ anchor: number; panelLeft: number }>();
  const drag = useRef<{ pointerId: number; startX: number; startAnchor: number; anchor: number; moved: boolean } | null>(null);
  const suppressClick = useRef(false);
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

  const moveToggle = (anchor: number) => {
    const panel = panelRef.current;
    const next = panel === null ? undefined : filterPosition(panel, toggleRef.current, anchor);
    if (next !== undefined) setPosition(next);
    return next?.anchor;
  };

  const finishDrag = () => {
    if (drag.current === null) return;
    suppressClick.current = drag.current.moved;
    if (drag.current.moved) onAnchorChange(drag.current.anchor);
    drag.current = null;
  };

  const startDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!event.isPrimary || event.button !== 0 || drag.current !== null) return;
    suppressClick.current = false;
    const startAnchor = event.currentTarget.offsetLeft;
    drag.current = { pointerId: event.pointerId, startX: event.clientX, startAnchor, anchor: startAnchor, moved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  useEffect(() => {
    const openWithShortcut = (event: KeyboardEvent) => {
      if (event.code !== "KeyF" || !event.altKey || event.ctrlKey || event.metaKey
        || event.shiftKey || event.repeat || event.defaultPrevented
        || document.querySelector('[role="dialog"], [role="menu"]') !== null) return;
      event.preventDefault();
      restoreToggleFocus.current = false;
      setOpen(true);
    };
    document.addEventListener("keydown", openWithShortcut);
    return () => document.removeEventListener("keydown", openWithShortcut);
  }, []);

  useLayoutEffect(() => {
    const panel = panelRef.current;
    const container = panel?.offsetParent;
    if (panel === null || !(container instanceof HTMLElement)) return;
    if (anchor !== undefined) setPosition(filterPosition(panel, toggleRef.current, anchor));
    const observer = new ResizeObserver(() => {
      setPosition(current => {
        if (current === undefined) return current;
        const next = filterPosition(panel, toggleRef.current, current.anchor);
        return next?.anchor === current.anchor && next.panelLeft === current.panelLeft ? current : next;
      });
    });
    observer.observe(container);
    observer.observe(panel);
    if (toggleRef.current !== null) observer.observe(toggleRef.current);
    return () => observer.disconnect();
  }, [anchor, open]);

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
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      restoreToggleFocus.current = true;
      setOpen(false);
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [open]);

  useEffect(() => {
    if (open) panelRef.current?.focus();
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
          : "Ticker filters · drag horizontally to reposition"}>
        <IconButton
          ref={toggleRef}
          className={[
            "ticker-lens-filter-toggle",
            effective ? "ticker-lens-filter-toggle-active" : "",
            pending ? "ticker-lens-filter-toggle-pending" : "",
          ].filter(Boolean).join(" ")}
          size="small"
          aria-label="Open ticker filters"
          aria-keyshortcuts="Alt+F"
          aria-expanded={false}
          style={{ left: position?.anchor }}
          onPointerDown={startDrag}
          onPointerMove={(event) => {
            const current = drag.current;
            if (current?.pointerId !== event.pointerId) return;
            const delta = event.clientX - current.startX;
            if (!current.moved && Math.abs(delta) < 4) return;
            current.moved = true;
            current.anchor = moveToggle(current.startAnchor + delta) ?? current.anchor;
          }}
          onPointerUp={(event) => {
            if (drag.current?.pointerId !== event.pointerId) return;
            finishDrag();
            if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          onPointerCancel={finishDrag}
          onLostPointerCapture={finishDrag}
          onKeyDown={(event) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            event.stopPropagation();
            const next = moveToggle(event.currentTarget.offsetLeft + (event.key === "ArrowLeft" ? -16 : 16));
            if (next !== undefined) onAnchorChange(next);
          }}
          onClick={(event) => {
            if (suppressClick.current && event.detail !== 0) {
              suppressClick.current = false;
              return;
            }
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
        tabIndex={-1}
        style={{ left: position?.panelLeft }}
        aria-hidden={!open}
        inert={!open}
      >
      <div className="ticker-lens-filters-header">
        <FilterAltIcon fontSize="small" />
        <Typography component="h3">Filters</Typography>
        <Typography className="ticker-lens-filter-count" component="span">
          {counts.filtered}
          <span> / {counts.total}</span>
        </Typography>
        <div>
          <Tooltip title={persisted ? "Stop persisting filter state" : "Persist filter state"}>
            <IconButton
              size="small"
              aria-label={persisted ? "Stop persisting filter state" : "Persist filter state"}
              aria-pressed={persisted}
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
          <Tooltip title="Close filters (Escape)">
            <IconButton
              size="small"
              aria-label="Close ticker filters"
              onClick={() => {
                restoreToggleFocus.current = true;
                setOpen(false);
              }}
            >
              <CloseIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </div>
      </div>
      {!enabled && <p className="ticker-lens-filter-hint">Select groups to apply filters</p>}
      <div className="ticker-lens-filter-column-label"><span>Minimum</span><span>Excluded</span></div>
      <FilterSlider
        checked={filters.adr.enabled}
        active={filters.adr.enabled && enabled}
        pending={filters.adr.enabled && !enabled}
        label="ADR"
        value={adrMin}
        max={20}
        step={0.1}
        valueLabel={`${adrMin.toFixed(1)}%`}
        excluded={enabled ? counts.excluded?.adr : undefined}
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
        excluded={enabled ? counts.excluded?.dollarVolume : undefined}
        onCheckedChange={(checked) => onChange({ ...filters, dollarVolume: { ...filters.dollarVolume, enabled: checked } })}
        onChange={(value) => onChange({ ...filters, dollarVolume: { ...filters.dollarVolume, min: value * 1_000_000 } })}
      />
      <div className={[
        "ticker-lens-filter-checkbox",
        filters.above200Sma.enabled && enabled ? "ticker-lens-filter-slider-active" : "",
        filters.above200Sma.enabled && !enabled ? "ticker-lens-filter-slider-pending" : "",
      ].filter(Boolean).join(" ")}>
        <label>
          <Checkbox
            size="small"
            checked={filters.above200Sma.enabled}
            slotProps={{ input: { "aria-label": "Enable 200SMA filter" } }}
            onChange={(event) => onChange({ ...filters, above200Sma: { enabled: event.target.checked } })}
          />
          <Typography component="span">Close &gt; 200SMA</Typography>
        </label>
        <ExcludedCount count={enabled ? counts.excluded?.above200Sma : undefined} enabled={filters.above200Sma.enabled} />
      </div>
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
  excluded,
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
  excluded: number | undefined;
  onCheckedChange: (checked: boolean) => void;
  onChange: (value: number) => void;
}) {
  return (
    <div className={[
      "ticker-lens-filter-slider",
      active ? "ticker-lens-filter-slider-active" : "",
      pending ? "ticker-lens-filter-slider-pending" : "",
    ].filter(Boolean).join(" ")}>
      <label>
        <Checkbox
          size="small"
          checked={checked}
          slotProps={{ input: { "aria-label": `Enable ${label} filter` } }}
          onChange={(event) => onCheckedChange(event.target.checked)}
        />
        <Typography component="span">{label}</Typography>
      </label>
      <Slider
        aria-label={`${label} minimum`}
        getAriaValueText={() => valueLabel}
        size="small"
        min={0}
        max={max}
        step={step}
        value={value}
        valueLabelDisplay="auto"
        onChange={(_, nextValue) => onChange(Array.isArray(nextValue) ? nextValue[0] : nextValue)}
      />
      <Typography className="ticker-lens-filter-value" component="span">{valueLabel}</Typography>
      <ExcludedCount count={excluded} enabled={checked} />
    </div>
  );
}

function ExcludedCount({ count, enabled }: { count: number | undefined; enabled: boolean }) {
  return <span className="ticker-lens-filter-excluded" title="Tickers excluded by this filter independently; counts may overlap">
    {enabled && count !== undefined ? `−${count}` : "—"}
  </span>;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function filterPosition(panel: HTMLElement, toggle: HTMLButtonElement | null, anchor: number) {
  const container = panel.offsetParent;
  if (!(container instanceof HTMLElement)) return undefined;
  const half = (toggle?.offsetWidth ?? 36) / 2;
  const bounded = clamp(anchor, half, Math.max(half, container.clientWidth - half));
  return { anchor: bounded, panelLeft: clamp(bounded - panel.offsetWidth / 2, 0, Math.max(0, container.clientWidth - panel.offsetWidth)) };
}
