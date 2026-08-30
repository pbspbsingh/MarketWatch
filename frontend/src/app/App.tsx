import { lazy, Suspense, useEffect } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { AppShell } from "./AppShell";

const CsvAnalyzerPage = lazy(() =>
  import("../features/csv-analyzer/CsvAnalyzerPage").then(({ CsvAnalyzerPage }) => ({
    default: CsvAnalyzerPage,
  })),
);
const HomePage = lazy(() =>
  import("../features/home/HomePage").then(({ HomePage }) => ({ default: HomePage })),
);
const WatchlistsPage = lazy(() =>
  import("../features/watchlists/WatchlistsPage").then(({ WatchlistsPage }) => ({
    default: WatchlistsPage,
  })),
);
const MarketWatchPage = lazy(() =>
  import("../features/market-watch/MarketWatchPage").then(({ MarketWatchPage }) => ({
    default: MarketWatchPage,
  })),
);
const MarketHealthPage = lazy(() =>
  import("../features/market-health/MarketHealthPage").then(({ MarketHealthPage }) => ({
    default: MarketHealthPage,
  })),
);
const ThemeManagementPage = lazy(() =>
  import("../features/theme-management/ThemeManagementPage").then(({ ThemeManagementPage }) => ({
    default: ThemeManagementPage,
  })),
);
const ThemeTrackerPage = lazy(() =>
  import("../features/theme-tracker/ThemeTrackerPage").then(({ ThemeTrackerPage }) => ({
    default: ThemeTrackerPage,
  })),
);
const ThemeRankPage = lazy(() =>
  import("../features/theme-rank/ThemeRankPage").then(({ ThemeRankPage }) => ({
    default: ThemeRankPage,
  })),
);
const TopStocksPage = lazy(() =>
  import("../features/top-stocks/TopStocksPage").then(({ TopStocksPage }) => ({
    default: TopStocksPage,
  })),
);
const HighestVolumePage = lazy(() =>
  import("../features/highest-volume/HighestVolumePage").then(({ HighestVolumePage }) => ({
    default: HighestVolumePage,
  })),
);
const StudyPage = lazy(() =>
  import("../features/study/StudyPage").then(({ StudyPage }) => ({ default: StudyPage })),
);
const DailyNotesPage = lazy(() =>
  import("../features/daily-notes/DailyNotesPage").then(({ DailyNotesPage }) => ({ default: DailyNotesPage })),
);
const TradeAnalyzerPage = lazy(() =>
  import("../features/trade-analyzer/TradeAnalyzerPage").then(({ TradeAnalyzerPage }) => ({ default: TradeAnalyzerPage })),
);

export function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<Page title="Home"><HomePage /></Page>} />
        <Route path="/market-watch" element={<Page title="Market Watch"><MarketWatchPage /></Page>} />
        <Route path="/market-health" element={<Page title="Market Health"><MarketHealthPage /></Page>} />
        <Route path="/favourites" element={<Navigate to="/watchlists" replace />} />
        <Route path="/watchlists" element={<Page title="Watchlists"><WatchlistsPage /></Page>} />
        <Route path="/watchlists/:id" element={<Page title="Watchlists"><WatchlistsPage /></Page>} />
        <Route path="/top-stocks" element={<Page title="Top Stocks"><TopStocksPage /></Page>} />
        <Route path="/highest-volume" element={<Page title="Highest Volume"><HighestVolumePage /></Page>} />
        <Route path="/csv-analyzer" element={<Page title="CSV Analyzer"><CsvAnalyzerPage /></Page>} />
        <Route path="/theme-management" element={<Page title="Theme Management"><ThemeManagementPage /></Page>} />
        <Route path="/theme-tracker" element={<Page title="Theme Tracker"><ThemeTrackerPage /></Page>} />
        <Route path="/theme-rank" element={<Page title="Theme Rank"><ThemeRankPage /></Page>} />
        <Route path="/study" element={<Page title="Study"><StudyPage /></Page>} />
        <Route path="/daily-notes" element={<Page title="Daily Notes"><DailyNotesPage /></Page>} />
        <Route path="/trade-analyzer" element={<Page title="Trade Analyzer"><TradeAnalyzerPage /></Page>} />
      </Route>
    </Routes>
  );
}

function Page({ title, children }: { title: string; children: React.ReactNode }) {
  useEffect(() => {
    document.title = `${title} | MarketWatch`;
  }, [title]);
  return <Suspense fallback={null}>{children}</Suspense>;
}
