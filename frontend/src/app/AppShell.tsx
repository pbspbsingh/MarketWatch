import { useEffect, useRef, useState, type PointerEvent } from "react";
import BubbleChartIcon from "@mui/icons-material/BubbleChart";
import CandlestickChartIcon from "@mui/icons-material/CandlestickChart";
import BookmarkIcon from "@mui/icons-material/Bookmark";
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
  Typography,
} from "@mui/material";
import { NavLink, Outlet } from "react-router-dom";

const destinations = [
  ["Market Watch", "/market-watch", CandlestickChartIcon, "purple"],
  ["Theme Tracker", "/theme-tracker", TrackChangesIcon, "amber"],
  ["Theme Rank", "/theme-rank", FormatListNumberedIcon, "lime"],
  ["Relative Rotation Graph", "/rrg", BubbleChartIcon, "cyan"],
  ["Watchlists", "/watchlists", BookmarkIcon, "yellow"],
  ["Top Stocks", "/top-stocks", TrendingUpIcon, "green"],
  ["CSV Analyzer", "/csv-analyzer", TableViewIcon, "coral"],
  ["Theme Management", "/theme-management", TuneIcon, "magenta"],
  ["Study", "/study", ScienceOutlinedIcon, "blue"],
  ["Daily Notes", "/daily-notes", NoteAltOutlinedIcon, "amber"],
] as const;

const navigationTriggerInset = 4;
const navigationTriggerPositionKey = "navigation-trigger-y";
const navigationModeKey = "navigation-mode";

type NavigationMode = "tray" | "rail";

function readNavigationMode(): NavigationMode {
  return localStorage.getItem(navigationModeKey) === "rail" ? "rail" : "tray";
}

function readNavigationTriggerPosition() {
  const storedValue = localStorage.getItem(navigationTriggerPositionKey);
  if (storedValue === null) return navigationTriggerInset;

  const storedPosition = Number(storedValue);
  return Number.isFinite(storedPosition) ? storedPosition : navigationTriggerInset;
}

export function AppShell() {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [navigationMode, setNavigationMode] = useState<NavigationMode>(readNavigationMode);
  const [triggerPosition, setTriggerPosition] = useState(readNavigationTriggerPosition);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dragState = useRef({
    pointerId: 0,
    startY: 0,
    startPosition: 0,
    currentPosition: 0,
    moved: false,
  });

  const clampTriggerPosition = (position: number) => {
    const triggerHeight = triggerRef.current?.offsetHeight ?? 28;
    const maximumPosition = Math.max(
      navigationTriggerInset,
      window.innerHeight - triggerHeight - navigationTriggerInset,
    );
    return Math.min(
      Math.max(position, navigationTriggerInset),
      maximumPosition,
    );
  };

  useEffect(() => {
    const clampPosition = () => setTriggerPosition((position) => clampTriggerPosition(position));
    clampPosition();
    window.addEventListener("resize", clampPosition);
    return () => window.removeEventListener("resize", clampPosition);
  }, []);

  const handlePointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;

    dragState.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startPosition: triggerPosition,
      currentPosition: triggerPosition,
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    const drag = dragState.current;
    if (event.pointerId !== drag.pointerId || !event.currentTarget.hasPointerCapture(event.pointerId)) {
      return;
    }

    const deltaY = event.clientY - drag.startY;
    if (Math.abs(deltaY) >= 4) drag.moved = true;
    if (drag.moved) {
      drag.currentPosition = clampTriggerPosition(drag.startPosition + deltaY);
      setTriggerPosition(drag.currentPosition);
    }
  };

  const handlePointerUp = (event: PointerEvent<HTMLButtonElement>) => {
    const drag = dragState.current;
    if (event.pointerId !== drag.pointerId) return;

    event.currentTarget.releasePointerCapture(event.pointerId);
    if (drag.moved) {
      localStorage.setItem(navigationTriggerPositionKey, String(drag.currentPosition));
    }
  };

  const handleTriggerClick = () => {
    if (dragState.current.moved) {
      dragState.current.moved = false;
      return;
    }
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
              ref={triggerRef}
              className="navigation-trigger"
              size="small"
              aria-label="Open navigation"
              style={{ top: triggerPosition }}
              onClick={handleTriggerClick}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerUp}
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
          <Tooltip title="Use sliding navigation" placement="right">
            <IconButton
              size="small"
              aria-label="Use sliding navigation"
              onClick={() => selectNavigationMode("tray")}
            >
              <PushPinIcon fontSize="small" />
            </IconButton>
          </Tooltip>
          <NavigationItems compact />
        </aside>
      )}

      <main className="workspace">
        <Outlet />
      </main>
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
