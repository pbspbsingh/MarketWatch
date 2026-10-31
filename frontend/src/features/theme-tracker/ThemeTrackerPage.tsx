import { useCallback, useEffect, useId, useMemo, useState } from "react";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import { ButtonBase, CircularProgress, ListItemIcon, ListItemText, Menu, MenuItem, ToggleButton, ToggleButtonGroup, Typography } from "@mui/material";
import type { TrackerMode, TrackerRow } from "../../api/generated/contracts";
import { useAppSettings } from "../../app/AppSettings";
import { Toast } from "../../components/Toast";
import { SplitPane } from "../../components/SplitPane";
import { restoreChartSplit, saveChartSplit } from "../../shared/chartLayout";
import { useLivePrices } from "../../shared/useLivePrices";
import { useMarketHours } from "../../shared/useMarketHours";
import { ChartPanel } from "../ticker-lens/ChartPanel";
import { industriesMarketWatchUrl, isArrowKeyControl, themeMarketWatchIdUrl } from "../ticker-lens/utils";
import { sortTrackerRows, trackerMetric, trackerRanges, type TrackerRange } from "./trackerStore";
import { useTrackerStream } from "./useTrackerStream";
import "./theme-tracker.css";

export function ThemeTrackerPage() {
  const { livePricesEnabled, showWeeklyChartOverlay, setShowWeeklyChartOverlay } = useAppSettings();
  const [overlayContainer, setOverlayContainer] = useState<HTMLElement | null>(null);
  const [initialSplit] = useState(() => restoreChartSplit("market-watch.theme-tracker-width", 30));
  const market = useMarketHours();
  const tracker = useTrackerStream(market.hours?.market_date);
  const { mode, rows, selectedKey, select, setMode, setRange, leaveTradingDay } = tracker;
  const [modeAnchor, setModeAnchor] = useState<HTMLElement | null>(null);
  const [contextMenu, setContextMenu] = useState<{ row: TrackerRow; mode: TrackerMode; top: number; left: number }>();
  const [dismissedMarketError, setDismissedMarketError] = useState<string>();
  const menuId = useId();
  const tdAllowed = livePricesEnabled && market.beforeClose;
  useEffect(() => { if (!tdAllowed) leaveTradingDay(); }, [leaveTradingDay, tdAllowed]);
  const requestedRange = tracker.ranges[mode];
  const range = requestedRange === "trading_day" && !tdAllowed ? tracker.historical[mode] : requestedRange;
  const symbols = useMemo(() => [...new Set(rows.map(row => row.etf_symbol))], [rows]);
  const live = useLivePrices({ enabled: tdAllowed && range === "trading_day", symbols });
  const sorted = useMemo(() => sortTrackerRows(rows, range, live.prices), [rows, range, live.prices]);
  const selected = rows.find(row => row.key === selectedKey);
  const groupKeys = useMemo(() => new Set(selected === undefined ? [] : mode === "theme" ? [selected.key] : selected.industry_keys), [selected, mode]);
  const industryKeys = useMemo(() => new Set(mode === "sector" ? selected?.industry_keys ?? [] : []), [selected, mode]);
  const ignoreTickerContext = useCallback(() => {}, []);
  const scale = useMemo(() => Math.max(0.01, ...sorted.map(row => Math.abs(trackerMetric(row, range, live.prices.get(row.etf_symbol)?.price) ?? 0))), [sorted, range, live.prices]);
  const latest = useMemo(() => [...live.prices.values()].reduce<string | undefined>((current, item) => current === undefined || item.updatedAt > current ? item.updatedAt : current, undefined), [live.prices]);

  useEffect(() => {
    const keyDown = (event: KeyboardEvent) => {
      if (event.code === "KeyW" && event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey
        && !event.repeat && !event.defaultPrevented && !isArrowKeyControl(event.target)
        && document.querySelector('[role="dialog"], [role="menu"]') === null) {
        event.preventDefault();
        setShowWeeklyChartOverlay(!showWeeklyChartOverlay);
        return;
      }
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || isArrowKeyControl(event.target)
        || document.querySelector('[role="dialog"], [role="menu"]') !== null || !["ArrowUp", "ArrowDown"].includes(event.key)) return;
      const index = sorted.findIndex(row => row.key === selectedKey);
      const next = sorted[index < 0 ? 0 : Math.max(0, Math.min(sorted.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))];
      if (next === undefined) return;
      event.preventDefault(); select(next.key);
      document.querySelector<HTMLElement>(`[data-tracker-key="${CSS.escape(next.key)}"]`)?.scrollIntoView({ block: "nearest" });
    };
    document.addEventListener("keydown", keyDown);
    return () => document.removeEventListener("keydown", keyDown);
  }, [select, selectedKey, sorted, setShowWeeklyChartOverlay, showWeeklyChartOverlay]);

  const chooseMode = (next: TrackerMode) => { setModeAnchor(null); setContextMenu(undefined); setMode(next); };
  const openInMarketWatch = () => {
    if (contextMenu === undefined) return;
    const url = contextMenu.mode === "theme" ? themeMarketWatchIdUrl(contextMenu.row.key) : industriesMarketWatchUrl(contextMenu.row.industry_keys);
    setContextMenu(undefined); window.open(url, "_blank", "noopener,noreferrer");
  };
  return (
    <section className="theme-tracker" ref={setOverlayContainer}>
      <SplitPane orientation="horizontal" initialSplit={initialSplit} onSplitChange={split => saveChartSplit("market-watch.theme-tracker-width", split)} first={
      <aside className="workspace-panel theme-tracker-panel">
        <header className="theme-tracker-header">
          <Typography component="h1">
            <ButtonBase id={`${menuId}-trigger`} className="theme-tracker-mode-title" aria-haspopup="menu" aria-expanded={modeAnchor !== null}
              aria-controls={modeAnchor === null ? undefined : menuId} onClick={event => setModeAnchor(event.currentTarget)}>
              {mode === "theme" ? "Theme" : "Sector"}<ExpandMoreIcon fontSize="small" />
            </ButtonBase>
          </Typography>
          <Menu id={menuId} anchorEl={modeAnchor} open={modeAnchor !== null} onClose={() => setModeAnchor(null)} slotProps={{ list: { "aria-labelledby": `${menuId}-trigger` } }}>
            <MenuItem selected={mode === "theme"} onClick={() => chooseMode("theme")}>Theme</MenuItem>
            <MenuItem selected={mode === "sector"} onClick={() => chooseMode("sector")}>Sector</MenuItem>
          </Menu>
          <ToggleButtonGroup exclusive size="small" value={range} aria-label="Performance range" onChange={(_, value: TrackerRange | null) => {
            if (value !== null && (value !== "trading_day" || tdAllowed)) setRange(value);
          }}>
            <ToggleButton value="trading_day" disabled={!tdAllowed}>TD</ToggleButton>
            {trackerRanges.map(item => <ToggleButton key={item.key} value={item.key}>{item.label}</ToggleButton>)}
          </ToggleButtonGroup>
        </header>
        {range === "trading_day" && latest !== undefined && <div className="theme-tracker-updated" title={new Date(latest).toLocaleString()}>Updated {new Date(latest).toLocaleTimeString()}</div>}
        {tracker.loading && rows.length === 0 ? <div className="panel-status"><CircularProgress size="1rem" /></div> : (
          <ol className="theme-tracker-list">
            {sorted.map(row => {
              const value = trackerMetric(row, range, live.prices.get(row.etf_symbol)?.price);
              return <li key={row.key}>
                <button className="theme-tracker-row" data-tracker-key={row.key} type="button" aria-pressed={selectedKey === row.key} title={row.error ?? undefined}
                  onClick={() => select(row.key)} onContextMenu={event => { event.preventDefault(); setContextMenu({ row, mode, top: event.clientY, left: event.clientX }); }}>
                  <span className="theme-tracker-name">{row.name} ({row.etf_symbol})</span>
                  <PerformanceBar value={value} scale={scale} />
                  <span className={`theme-tracker-value ${value === undefined ? "" : value >= 0 ? "positive" : "negative"}`}>
                    {row.loading && value === undefined ? <CircularProgress size="0.65rem" aria-label={`Loading ${row.name} performance`} /> : value === undefined ? "—" : `${value >= 0 ? "+" : ""}${(value * 100).toFixed(2)}%`}
                  </span>
                </button>
              </li>;
            })}
            {!tracker.loading && rows.length === 0 && <li className="panel-status">No {mode === "theme" ? "themes" : "sectors"} available</li>}
          </ol>
        )}
        <Menu open={contextMenu !== undefined} onClose={() => setContextMenu(undefined)} anchorReference="anchorPosition"
          anchorPosition={contextMenu === undefined ? undefined : { top: contextMenu.top, left: contextMenu.left }} slotProps={{ list: { dense: true, "aria-label": "Theme Tracker group actions" } }}>
          <MenuItem disabled={contextMenu?.mode === "sector" && contextMenu.row.industry_keys.length === 0} onClick={openInMarketWatch}>
            <ListItemIcon><OpenInNewIcon fontSize="small" /></ListItemIcon><ListItemText>Open in Market Watch</ListItemText>
          </MenuItem>
        </Menu>
      </aside>} second={
      <ChartPanel overlayContainer={overlayContainer} mode={mode === "theme" ? "theme" : "industry"} groupKeys={groupKeys} industryKeys={industryKeys} selectedTicker={selected?.etf_symbol}
        onSelectedTickerContext={ignoreTickerContext} horizontalDetailsNavigation={false} forceSystemBenchmark />} />
      <Toast message={tracker.error} onClose={tracker.clearError} />
      <Toast message={live.error} onClose={live.clearError} />
      <Toast message={market.error === dismissedMarketError ? undefined : market.error} onClose={() => setDismissedMarketError(market.error)} />
    </section>
  );
}

function PerformanceBar({ value, scale }: { value: number | undefined; scale: number }) {
  if (value === undefined) return <span className="performance-bar" />;
  const width = `${Math.min(50, Math.abs(value) / scale * 50)}%`;
  return <span className="performance-bar"><span className={value >= 0 ? "bar-positive" : "bar-negative"} style={{ width, [value >= 0 ? "left" : "right"]: "50%" }} /></span>;
}
