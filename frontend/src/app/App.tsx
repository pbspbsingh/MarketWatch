import { Navigate, Route, Routes } from "react-router-dom";
import { AppShell } from "./AppShell";
import { MarketWatchPage } from "../features/market-watch/MarketWatchPage";
import { ThemeManagementPage } from "../features/theme-management/ThemeManagementPage";

export function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<Navigate to="/market-watch" replace />} />
        <Route path="/market-watch" element={<MarketWatchPage />} />
        <Route path="/theme-management" element={<ThemeManagementPage />} />
      </Route>
    </Routes>
  );
}
