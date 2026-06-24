import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { AppShell } from "./AppShell";

const CsvAnalyzerPage = lazy(() =>
  import("../features/csv-analyzer/CsvAnalyzerPage").then(({ CsvAnalyzerPage }) => ({
    default: CsvAnalyzerPage,
  })),
);
const FavouritesPage = lazy(() =>
  import("../features/favourites/FavouritesPage").then(({ FavouritesPage }) => ({
    default: FavouritesPage,
  })),
);
const MarketWatchPage = lazy(() =>
  import("../features/market-watch/MarketWatchPage").then(({ MarketWatchPage }) => ({
    default: MarketWatchPage,
  })),
);
const ThemeManagementPage = lazy(() =>
  import("../features/theme-management/ThemeManagementPage").then(({ ThemeManagementPage }) => ({
    default: ThemeManagementPage,
  })),
);
const RrgPage = lazy(() =>
  import("../features/rrg/RrgPage").then(({ RrgPage }) => ({ default: RrgPage })),
);
const TopStocksPage = lazy(() =>
  import("../features/top-stocks/TopStocksPage").then(({ TopStocksPage }) => ({
    default: TopStocksPage,
  })),
);

export function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<Navigate to="/market-watch" replace />} />
        <Route path="/market-watch" element={<Page><MarketWatchPage /></Page>} />
        <Route path="/favourites" element={<Page><FavouritesPage /></Page>} />
        <Route path="/top-stocks" element={<Page><TopStocksPage /></Page>} />
        <Route path="/csv-analyzer" element={<Page><CsvAnalyzerPage /></Page>} />
        <Route path="/theme-management" element={<Page><ThemeManagementPage /></Page>} />
        <Route path="/rrg" element={<Page><RrgPage /></Page>} />
        <Route path="/trend-analyzer" element={<TrendAnalyzerPlaceholder />} />
      </Route>
    </Routes>
  );
}

function Page({ children }: { children: React.ReactNode }) {
  return <Suspense fallback={null}>{children}</Suspense>;
}

function TrendAnalyzerPlaceholder() {
  return (
    <section className="bounded-empty-page" aria-label="Trend Analyzer">
      <span>Work in progress</span>
    </section>
  );
}
