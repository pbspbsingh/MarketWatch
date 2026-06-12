import { Navigate, Route, Routes } from "react-router-dom";
import { AppShell } from "./AppShell";
import { MarketWatchPage } from "../features/market-watch/MarketWatchPage";

export function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<Navigate to="/market-watch" replace />} />
        <Route path="/market-watch" element={<MarketWatchPage />} />
      </Route>
    </Routes>
  );
}
