import { useState } from "react";
import { NavLink, Outlet } from "react-router-dom";

const destinations = [
  ["Market Watch", "/market-watch"],
  ["Trend Analyzer", "/trend-analyzer"],
  ["CSV Analyzer", "/csv-analyzer"],
  ["Theme Management", "/theme-management"],
] as const;

export function AppShell() {
  const [drawerOpen, setDrawerOpen] = useState(false);

  return (
    <div className="app-shell">
      <button
        className="navigation-trigger"
        type="button"
        aria-label="Open navigation"
        onClick={() => setDrawerOpen(true)}
      >
        ☰
      </button>

      {drawerOpen && (
        <>
          <button
            className="drawer-backdrop"
            aria-label="Close navigation"
            onClick={() => setDrawerOpen(false)}
          />
          <nav className="navigation-drawer" aria-label="Primary navigation">
            <div className="drawer-title">Navigation</div>
            {destinations.map(([label, path]) => (
              <NavLink key={path} to={path} onClick={() => setDrawerOpen(false)}>
                {label}
              </NavLink>
            ))}
          </nav>
        </>
      )}

      <main className="workspace">
        <Outlet />
      </main>
    </div>
  );
}
