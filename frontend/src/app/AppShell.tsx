import { useCallback, useEffect, useRef, useState, type PointerEvent } from "react";
import CandlestickChartIcon from "@mui/icons-material/CandlestickChart";
import BookmarkIcon from "@mui/icons-material/Bookmark";
import ChevronLeftIcon from "@mui/icons-material/ChevronLeft";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import ScienceOutlinedIcon from "@mui/icons-material/ScienceOutlined";
import NoteAltOutlinedIcon from "@mui/icons-material/NoteAltOutlined";
import MenuBookOutlinedIcon from "@mui/icons-material/MenuBookOutlined";
import TableViewIcon from "@mui/icons-material/TableView";
import TrendingUpIcon from "@mui/icons-material/TrendingUp";
import TuneIcon from "@mui/icons-material/Tune";
import FormatListNumberedIcon from "@mui/icons-material/FormatListNumbered";
import TravelExploreOutlinedIcon from "@mui/icons-material/TravelExploreOutlined";
import {
  IconButton,
  List,
  ListItemButton,
  ListItemIcon,
  Tooltip,
} from "@mui/material";
import { NavLink, Outlet } from "react-router-dom";
import { SettingsDrawer } from "./SettingsDrawer";

const destinations = [
  ["Market Watch", "/market-watch", CandlestickChartIcon, "purple"],
  ["Theme Tracker", "/theme-tracker", FormatListNumberedIcon, "amber"],
  ["Market Explorer", "/market-explorer", TravelExploreOutlinedIcon, "blue"],
  ["Top Stocks", "/top-stocks", TrendingUpIcon, "green"],
  ["CSV Analyzer", "/csv-analyzer", TableViewIcon, "coral"],
  ["Watchlists", "/watchlists", BookmarkIcon, "yellow"],
  ["Theme Management", "/theme-management", TuneIcon, "magenta"],
  ["Study", "/study", ScienceOutlinedIcon, "blue"],
  ["Daily Notes", "/daily-notes", NoteAltOutlinedIcon, "amber"],
  ["Trade Logs", "/trade-logs", MenuBookOutlinedIcon, "green"],
] as const;

const triggerInset = 4;
const settingsTriggerPositionKey = "settings-trigger-y";

function readSettingsTriggerPosition() {
  const storedValue = localStorage.getItem(settingsTriggerPositionKey);
  if (storedValue === null) return triggerInset;

  const storedPosition = Number(storedValue);
  return Number.isFinite(storedPosition) ? storedPosition : triggerInset;
}

function useSettingsTrigger() {
  const [position, setPosition] = useState(readSettingsTriggerPosition);
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
    if (state.moved) localStorage.setItem(settingsTriggerPositionKey, String(state.currentPosition));
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
  const [settingsOpen, setSettingsOpen] = useState(false);
  const {
    ref: settingsTriggerRef,
    position: settingsTriggerPosition,
    consumeDrag: consumeSettingsDrag,
    handlePointerDown: handleSettingsPointerDown,
    handlePointerMove: handleSettingsPointerMove,
    handlePointerUp: handleSettingsPointerUp,
  } = useSettingsTrigger();

  return (
    <div className="app-shell">
      <aside className="navigation-rail">
        <Tooltip title="Market Watch" placement="right">
          <NavLink className="navigation-rail-brand" to="/" aria-label="Home">
            <img
              className={import.meta.env.DEV ? "development-logo" : undefined}
              src="/favicon.svg"
              alt="Market Watch"
            />
          </NavLink>
        </Tooltip>
        <NavigationItems />
      </aside>

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
      <SettingsDrawer open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}

function NavigationItems() {
  return (
    <List dense disablePadding component="nav" aria-label="Primary navigation">
      {destinations.map(([label, path, DestinationIcon, accent]) => (
        <Tooltip key={path} title={label} placement="right">
          <ListItemButton component={NavLink} to={path} aria-label={label}>
            <ListItemIcon className={`navigation-icon-${accent}`}>
              <DestinationIcon fontSize="small" />
            </ListItemIcon>
          </ListItemButton>
        </Tooltip>
      ))}
    </List>
  );
}
