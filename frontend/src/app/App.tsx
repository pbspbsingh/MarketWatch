import { lazy, Suspense, useEffect } from "react";
import { CircularProgress, Snackbar, Typography } from "@mui/material";
import { useStore } from "zustand";
import { Navigate, Route, Routes } from "react-router-dom";
import { AppShell } from "./AppShell";
import { applicationEvents } from "../api/applicationEvents";
import { applicationConnection } from "../shared/applicationConnection";

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
const TopStocksPage = lazy(() =>
  import("../features/top-stocks/TopStocksPage").then(({ TopStocksPage }) => ({
    default: TopStocksPage,
  })),
);
const MarketExplorerPage = lazy(() =>
  import("../features/market-explorer/MarketExplorerPage").then(({ MarketExplorerPage }) => ({
    default: MarketExplorerPage,
  })),
);
const StudyPage = lazy(() =>
  import("../features/study/StudyPage").then(({ StudyPage }) => ({ default: StudyPage })),
);
const DailyNotesPage = lazy(() =>
  import("../features/daily-notes/DailyNotesPage").then(({ DailyNotesPage }) => ({ default: DailyNotesPage })),
);
const TradeLogsPage = lazy(() =>
  import("../features/trade-logs/TradeLogsPage").then(({ TradeLogsPage }) => ({ default: TradeLogsPage })),
);

export function App() {
  const connectionStatus = useStore(applicationConnection, state => state.status);
  useEffect(() => {
    applicationEvents.start();
    return () => applicationEvents.stop();
  }, []);
  return (
    <>
      <Snackbar open={connectionStatus === "reconnecting"} message="Connection lost. Reconnecting…" />
      <Routes>
        <Route element={<AppShell />}>
          <Route index element={<Page title="Home"><HomePage /></Page>} />
          <Route path="/market-watch" element={<Page title="Market Watch"><MarketWatchPage /></Page>} />
          <Route path="/favourites" element={<Navigate to="/watchlists" replace />} />
          <Route path="/watchlists" element={<Page title="Watchlists"><WatchlistsPage /></Page>} />
          <Route path="/watchlists/:id" element={<Page title="Watchlists"><WatchlistsPage /></Page>} />
          <Route path="/top-stocks" element={<Page title="Top Stocks"><TopStocksPage /></Page>} />
          <Route path="/market-explorer" element={<Page title="Market Explorer"><MarketExplorerPage /></Page>} />
          <Route path="/csv-analyzer" element={<Page title="CSV Analyzer"><CsvAnalyzerPage /></Page>} />
          <Route path="/theme-management" element={<Page title="Theme Management"><ThemeManagementPage /></Page>} />
          <Route path="/theme-tracker" element={<Page title="Theme Tracker"><ThemeTrackerPage /></Page>} />
          <Route path="/study" element={<Page title="Study"><StudyPage /></Page>} />
          <Route path="/daily-notes" element={<Page title="Daily Notes"><DailyNotesPage /></Page>} />
          <Route path="/trade-logs" element={<Page title="Trade Logs"><TradeLogsPage /></Page>} />
        </Route>
      </Routes>
    </>
  );
}

function Page({ title, children }: { title: string; children: React.ReactNode }) {
  useEffect(() => {
    document.title = `${title} | MarketWatch`;
  }, [title]);
  return (
    <Suspense fallback={(
      <div className="panel-status" role="status">
        <CircularProgress size="1rem" />
        <Typography color="text.secondary">Loading {title}</Typography>
      </div>
    )}>
      {children}
    </Suspense>
  );
}
