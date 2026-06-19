import { useEffect, useRef, useState, type PointerEvent } from "react";
import CandlestickChartIcon from "@mui/icons-material/CandlestickChart";
import MenuIcon from "@mui/icons-material/Menu";
import StarIcon from "@mui/icons-material/Star";
import TableViewIcon from "@mui/icons-material/TableView";
import TimelineIcon from "@mui/icons-material/Timeline";
import TrendingUpIcon from "@mui/icons-material/TrendingUp";
import TuneIcon from "@mui/icons-material/Tune";
import {
  Drawer,
  IconButton,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Tooltip,
} from "@mui/material";
import { NavLink, Outlet } from "react-router-dom";

const destinations = [
  ["Market Watch", "/market-watch", CandlestickChartIcon, "purple"],
  ["Favourites", "/favourites", StarIcon, "yellow"],
  ["Top Stocks", "/top-stocks", TrendingUpIcon, "green"],
  ["CSV Analyzer", "/csv-analyzer", TableViewIcon, "blue"],
  ["Trend Analyzer", "/trend-analyzer", TimelineIcon],
  ["Theme Management", "/theme-management", TuneIcon],
] as const;

const navigationTriggerInset = 4;
const navigationTriggerPositionKey = "navigation-trigger-y";

function readNavigationTriggerPosition() {
  const storedValue = localStorage.getItem(navigationTriggerPositionKey);
  if (storedValue === null) return navigationTriggerInset;

  const storedPosition = Number(storedValue);
  return Number.isFinite(storedPosition) ? storedPosition : navigationTriggerInset;
}

export function AppShell() {
  const [drawerOpen, setDrawerOpen] = useState(false);
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

  return (
    <div className="app-shell">
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
        <List dense disablePadding component="nav" aria-label="Primary navigation">
          {destinations.map(([label, path, DestinationIcon, accent]) => (
            <ListItemButton
              component={NavLink}
              key={path}
              to={path}
              onClick={() => setDrawerOpen(false)}
            >
              <ListItemIcon className={accent === undefined ? undefined : `navigation-icon-${accent}`}>
                <DestinationIcon fontSize="small" />
              </ListItemIcon>
              <ListItemText primary={label} />
            </ListItemButton>
          ))}
        </List>
      </Drawer>

      <main className="workspace">
        <Outlet />
      </main>
    </div>
  );
}
