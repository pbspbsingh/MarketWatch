import { Navigate, Route, Routes } from "react-router-dom";
import { AppShell } from "./AppShell";
import { CsvAnalyzerPage } from "../features/csv-analyzer/CsvAnalyzerPage";
import { FavouritesPage } from "../features/favourites/FavouritesPage";
import { MarketWatchPage } from "../features/market-watch/MarketWatchPage";
import { ThemeManagementPage } from "../features/theme-management/ThemeManagementPage";
import { TopStocksPage } from "../features/top-stocks/TopStocksPage";

export function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<Navigate to="/market-watch" replace />} />
        <Route path="/market-watch" element={<MarketWatchPage />} />
        <Route path="/favourites" element={<FavouritesPage />} />
        <Route path="/top-stocks" element={<TopStocksPage />} />
        <Route path="/csv-analyzer" element={<CsvAnalyzerPage />} />
        <Route path="/theme-management" element={<ThemeManagementPage />} />
      </Route>
    </Routes>
  );
}
