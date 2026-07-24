import { useCallback, useEffect, useRef, useState, type PointerEvent } from "react";
import CandlestickChartIcon from "@mui/icons-material/CandlestickChart";
import BookmarkIcon from "@mui/icons-material/Bookmark";
import ChevronLeftIcon from "@mui/icons-material/ChevronLeft";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import MenuIcon from "@mui/icons-material/Menu";
import PushPinIcon from "@mui/icons-material/PushPin";
import PushPinOutlinedIcon from "@mui/icons-material/PushPinOutlined";
import ScienceOutlinedIcon from "@mui/icons-material/ScienceOutlined";
import NoteAltOutlinedIcon from "@mui/icons-material/NoteAltOutlined";
import TableViewIcon from "@mui/icons-material/TableView";
import TrendingUpIcon from "@mui/icons-material/TrendingUp";
import TuneIcon from "@mui/icons-material/Tune";
import TrackChangesIcon from "@mui/icons-material/TrackChanges";
import FormatListNumberedIcon from "@mui/icons-material/FormatListNumbered";
import {
  Drawer,
  IconButton,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Tooltip,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from "@mui/material";
import { NavLink, Outlet } from "react-router-dom";
import { useAppSettings } from "./AppSettings";

const destinations = [
  ["Market Watch", "/market-watch", CandlestickChartIcon, "purple"],
  ["Theme Tracker", "/theme-tracker", TrackChangesIcon, "amber"],
  ["Theme Rank", "/theme-rank", FormatListNumberedIcon, "lime"],
  ["Watchlists", "/watchlists", BookmarkIcon, "yellow"],
  ["Top Stocks", "/top-stocks", TrendingUpIcon, "green"],
  ["CSV Analyzer", "/csv-analyzer", TableViewIcon, "coral"],
  ["Theme Management", "/theme-management", TuneIcon, "magenta"],
  ["Study", "/study", ScienceOutlinedIcon, "blue"],
  ["Daily Notes", "/daily-notes", NoteAltOutlinedIcon, "amber"],
] as const;

const triggerInset = 4;
const navigationTriggerPositionKey = "navigation-trigger-y";
const settingsTriggerPositionKey = "settings-trigger-y";
const navigationModeKey = "navigation-mode";

type NavigationMode = "tray" | "rail";

function readNavigationMode(): NavigationMode {
  return localStorage.getItem(navigationModeKey) === "rail" ? "rail" : "tray";
}

function readTriggerPosition(key: string) {
  const storedValue = localStorage.getItem(key);
  if (storedValue === null) return triggerInset;

  const storedPosition = Number(storedValue);
  return Number.isFinite(storedPosition) ? storedPosition : triggerInset;
}

function useVerticalTrigger(positionKey: string) {
  const [position, setPosition] = useState(() => readTriggerPosition(positionKey));
  const ref = useRef<HTMLButtonElement>(null);
  const drag = useRef({
    pointerId: 0,
    startY: 0,
    startPosition: 0,
    currentPosition: 0,
    moved: false,
  });
  const clampPosition = useCallback((value: number) => {
    const triggerHeight = ref.current?.offsetHeight ?? 28;
    const maximumPosition = Math.max(
      triggerInset,
      window.innerHeight - triggerHeight - triggerInset,
    );
    return Math.min(Math.max(value, triggerInset), maximumPosition);
  }, []);

  useEffect(() => {
    const handleResize = () => setPosition((current) => clampPosition(current));
    handleResize();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [clampPosition]);

  const handlePointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    drag.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startPosition: position,
      currentPosition: position,
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    const state = drag.current;
    if (
      event.pointerId !== state.pointerId
      || !event.currentTarget.hasPointerCapture(event.pointerId)
    ) return;

    const deltaY = event.clientY - state.startY;
    if (Math.abs(deltaY) >= 4) state.moved = true;
    if (!state.moved) return;
    state.currentPosition = clampPosition(state.startPosition + deltaY);
    setPosition(state.currentPosition);
  };

  const handlePointerUp = (event: PointerEvent<HTMLButtonElement>) => {
    const state = drag.current;
    if (event.pointerId !== state.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (state.moved) localStorage.setItem(positionKey, String(state.currentPosition));
  };

  const consumeDrag = () => {
    if (!drag.current.moved) return false;
    drag.current.moved = false;
    return true;
  };

  return {
    ref,
    position,
    consumeDrag,
    handlePointerDown,
    handlePointerMove,
    handlePointerUp,
  };
}

export function AppShell() {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const {
    candlePalette,
    chartEngine,
    setCandlePalette,
    setChartEngine,
    theme,
    setTheme,
  } = useAppSettings();
  const [navigationMode, setNavigationMode] = useState<NavigationMode>(readNavigationMode);
  const {
    ref: navigationTriggerRef,
    position: navigationTriggerPosition,
    consumeDrag: consumeNavigationDrag,
    handlePointerDown: handleNavigationPointerDown,
    handlePointerMove: handleNavigationPointerMove,
    handlePointerUp: handleNavigationPointerUp,
  } = useVerticalTrigger(navigationTriggerPositionKey);
  const {
    ref: settingsTriggerRef,
    position: settingsTriggerPosition,
    consumeDrag: consumeSettingsDrag,
    handlePointerDown: handleSettingsPointerDown,
    handlePointerMove: handleSettingsPointerMove,
    handlePointerUp: handleSettingsPointerUp,
  } = useVerticalTrigger(settingsTriggerPositionKey);

  const handleTriggerClick = () => {
    if (consumeNavigationDrag()) return;
    setDrawerOpen(true);
  };

  const selectNavigationMode = (mode: NavigationMode) => {
    localStorage.setItem(navigationModeKey, mode);
    setNavigationMode(mode);
    setDrawerOpen(false);
  };

  return (
    <div className="app-shell">
      {navigationMode === "tray" ? (
        <>
          <Tooltip title="Open navigation">
            <IconButton
              ref={navigationTriggerRef}
              className="navigation-trigger"
              size="small"
              aria-label="Open navigation"
              style={{ top: navigationTriggerPosition }}
              onClick={handleTriggerClick}
              onPointerDown={handleNavigationPointerDown}
              onPointerMove={handleNavigationPointerMove}
              onPointerUp={handleNavigationPointerUp}
              onPointerCancel={handleNavigationPointerUp}
            >
              <MenuIcon fontSize="small" />
            </IconButton>
          </Tooltip>

          <Drawer
            open={drawerOpen}
            onClose={() => setDrawerOpen(false)}
            slotProps={{ paper: { className: "navigation-drawer" } }}
          >
            <div className="navigation-drawer-header">
              <Typography variant="subtitle2">Navigation</Typography>
              <Tooltip title="Keep navigation visible">
                <IconButton
                  size="small"
                  aria-label="Keep navigation visible"
                  onClick={() => selectNavigationMode("rail")}
                >
                  <PushPinOutlinedIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            </div>
            <NavigationItems onNavigate={() => setDrawerOpen(false)} />
          </Drawer>
        </>
      ) : (
        <aside className="navigation-rail">
          <Tooltip title="Market Watch" placement="right">
            <span className="navigation-rail-brand">
              <img src="/favicon.svg" alt="Market Watch" />
            </span>
          </Tooltip>
          <NavigationItems compact />
          <Tooltip title="Use sliding navigation" placement="right">
            <IconButton
              className="navigation-mode-button"
              size="small"
              aria-label="Use sliding navigation"
              onClick={() => selectNavigationMode("tray")}
            >
              <PushPinIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </aside>
      )}

      <main className="workspace">
        <Outlet />
      </main>
      <Tooltip title={settingsOpen ? "Close settings" : "Open settings"} placement="left">
        <IconButton
          ref={settingsTriggerRef}
          className="settings-trigger"
          size="small"
          aria-label={settingsOpen ? "Close settings" : "Open settings"}
          aria-expanded={settingsOpen}
          style={{ top: settingsTriggerPosition }}
          onClick={() => {
            if (!consumeSettingsDrag()) setSettingsOpen((open) => !open);
          }}
          onPointerDown={handleSettingsPointerDown}
          onPointerMove={handleSettingsPointerMove}
          onPointerUp={handleSettingsPointerUp}
          onPointerCancel={handleSettingsPointerUp}
        >
          {settingsOpen ? <ChevronRightIcon fontSize="small" /> : <ChevronLeftIcon fontSize="small" />}
        </IconButton>
      </Tooltip>
      <Drawer
        anchor="right"
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        slotProps={{ paper: { className: "settings-drawer" } }}
      >
        <div className="settings-drawer-header">
          <Typography variant="subtitle2">Settings</Typography>
          <IconButton size="small" aria-label="Close settings" onClick={() => setSettingsOpen(false)}>
            <ChevronRightIcon fontSize="small" />
          </IconButton>
        </div>
        <section className="settings-section" aria-labelledby="appearance-setting">
          <Typography id="appearance-setting" variant="overline">Appearance</Typography>
          <div className="settings-control">
            <Typography className="settings-control-label" color="text.secondary">
              Theme
            </Typography>
            <ToggleButtonGroup
              exclusive
              fullWidth
              size="small"
              value={theme}
              aria-label="Color theme"
              onChange={(_, nextTheme) => {
                if (nextTheme === "dark" || nextTheme === "light") setTheme(nextTheme);
              }}
            >
              <ToggleButton value="light" aria-label="Light theme">Light</ToggleButton>
              <ToggleButton value="dark" aria-label="Dark theme">Dark</ToggleButton>
            </ToggleButtonGroup>
          </div>
        </section>
        <section className="settings-section" aria-labelledby="chart-setting">
          <Typography id="chart-setting" variant="overline">Charts</Typography>
          <div className="settings-control">
            <Typography className="settings-control-label" color="text.secondary">
              Engine
            </Typography>
            <ToggleButtonGroup
              exclusive
              fullWidth
              size="small"
              value={chartEngine}
              aria-label="Chart engine"
              onChange={(_, nextEngine) => {
                if (nextEngine === "tradingview" || nextEngine === "lightweight") {
                  setChartEngine(nextEngine);
                }
              }}
            >
              <ToggleButton value="tradingview" aria-label="TradingView chart">
                TradingView
              </ToggleButton>
              <ToggleButton value="lightweight" aria-label="Lightweight Charts">
                Lightweight
              </ToggleButton>
            </ToggleButtonGroup>
          </div>
          <div className="settings-control">
            <Typography className="settings-control-label" color="text.secondary">
              Candles
            </Typography>
            <ToggleButtonGroup
              disabled={chartEngine !== "lightweight"}
              exclusive
              fullWidth
              size="small"
              value={candlePalette}
              aria-label="Candle palette"
              onChange={(_, nextPalette) => {
                if (nextPalette === "solid" || nextPalette === "hollow") {
                  setCandlePalette(nextPalette);
                }
              }}
            >
              <ToggleButton value="solid" aria-label="Red and green candles">
                Solid
              </ToggleButton>
              <ToggleButton value="hollow" aria-label="Red and hollow green candles">
                Hollow
              </ToggleButton>
            </ToggleButtonGroup>
          </div>
        </section>
      </Drawer>
      {import.meta.env.DEV && <span className="development-badge" aria-hidden="true">DEV</span>}
    </div>
  );
}

function NavigationItems({
  compact = false,
  onNavigate,
}: {
  compact?: boolean;
  onNavigate?: () => void;
}) {
  return (
    <List dense disablePadding component="nav" aria-label="Primary navigation">
      {destinations.map(([label, path, DestinationIcon, accent]) => {
        const item = (
          <ListItemButton
            component={NavLink}
            key={path}
            to={path}
            aria-label={compact ? label : undefined}
            onClick={onNavigate}
          >
            <ListItemIcon className={`navigation-icon-${accent}`}>
              <DestinationIcon fontSize="small" />
            </ListItemIcon>
            {!compact && <ListItemText primary={label} />}
          </ListItemButton>
        );
        return compact ? (
          <Tooltip key={path} title={label} placement="right">
            {item}
          </Tooltip>
        ) : item;
      })}
    </List>
  );
}
