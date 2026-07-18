import { useEffect, useRef, useState } from "react";
import RefreshIcon from "@mui/icons-material/Refresh";
import {
  CircularProgress,
  Dialog,
  DialogContent,
  DialogTitle,
  IconButton,
  Tab,
  Tabs,
  Typography,
} from "@mui/material";
import {
  fetchTickerDetails,
  type TickerDetails,
} from "../api/details";
import {
  fetchAiCapability,
  fetchThemeTicker,
  fetchThemes,
  replaceTickerThemes,
  suggestThemeAssignments,
  type AiCapability,
  type Theme,
  type ThemeSuggestion,
  type ThemeTicker,
} from "../api/themes";
import { TickerFundamentalsTab } from "./TickerFundamentalsTab";
import { TickerProfileThemesTab } from "./TickerProfileThemesTab";
import { Toast } from "./Toast";
import "./ticker-details-dialog.css";

interface TickerDetailsDialogProps {
  symbol?: string;
  open: boolean;
  onClose: () => void;
  onThemeChanged?: () => void;
}

const detailsTabs = ["fundamentals", "profile-themes"] as const;
type DetailsTab = (typeof detailsTabs)[number];

export function TickerDetailsDialog({
  symbol,
  open,
  onClose,
  onThemeChanged,
}: TickerDetailsDialogProps) {
  if (!open || symbol === undefined) return null;
  return (
    <OpenTickerDetailsDialog
      key={symbol}
      symbol={symbol}
      onClose={onClose}
      onThemeChanged={onThemeChanged}
    />
  );
}

function OpenTickerDetailsDialog({
  symbol,
  onClose,
  onThemeChanged,
}: Omit<TickerDetailsDialogProps, "open" | "symbol"> & { symbol: string }) {
  const [details, setDetails] = useState<TickerDetails>();
  const [themes, setThemes] = useState<Theme[]>([]);
  const [themeTicker, setThemeTicker] = useState<ThemeTicker>();
  const [draftThemeIds, setDraftThemeIds] = useState<number[]>([]);
  const [suggestedThemeIds, setSuggestedThemeIds] = useState<number[]>([]);
  const [aiCapability, setAiCapability] = useState<AiCapability>({
    enabled: false,
    model: null,
    batch_size: null,
  });
  const [tab, setTab] = useState<DetailsTab>("fundamentals");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [savingThemes, setSavingThemes] = useState(false);
  const [suggestingThemes, setSuggestingThemes] = useState(false);
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [messageSeverity, setMessageSeverity] = useState<"success" | "info" | "warning">(
    "success",
  );
  const [suggestions, setSuggestions] = useState<ThemeSuggestion[]>([]);
  const requestRef = useRef<AbortController | undefined>(undefined);
  const themesLoading = tab === "profile-themes" && themeTicker === undefined;

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        isKeyboardInput(event.target) ||
        (event.key !== "ArrowLeft" && event.key !== "ArrowRight")
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      setTab((current) => {
        const index = detailsTabs.indexOf(current);
        const direction = event.key === "ArrowRight" ? 1 : -1;
        return detailsTabs[
          (index + direction + detailsTabs.length) % detailsTabs.length
        ];
      });
    };
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, []);

  const refreshDetails = () => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setRefreshing(true);
    fetchTickerDetails(symbol, true, controller.signal)
      .then(setDetails)
      .catch((requestError: unknown) => {
        if (requestError instanceof Error && requestError.name !== "AbortError") {
          setError(requestError.message);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setLoading(false);
          setRefreshing(false);
        }
      });
  };

  const loadThemes = async () => {
    try {
      const [nextThemes, nextTicker] = await Promise.all([
        fetchThemes(),
        fetchThemeTicker(symbol),
      ]);
      setThemes(nextThemes);
      setThemeTicker(nextTicker);
      setDraftThemeIds(nextTicker.assignments.map((assignment) => assignment.theme_id));
      setSuggestedThemeIds([]);
    } catch (loadError) {
      setError(errorMessage(loadError));
    }
  };

  useEffect(() => {
    const controller = new AbortController();
    requestRef.current = controller;
    fetchTickerDetails(symbol, false, controller.signal)
      .then(setDetails)
      .catch((requestError: unknown) => {
        if (requestError instanceof Error && requestError.name !== "AbortError") {
          setError(requestError.message);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [symbol]);

  useEffect(() => {
    if (tab !== "profile-themes") return;
    let active = true;
    Promise.all([fetchThemes(), fetchThemeTicker(symbol)])
      .then(([nextThemes, nextTicker]) => {
        if (!active) return;
        setThemes(nextThemes);
        setThemeTicker(nextTicker);
        setDraftThemeIds(nextTicker.assignments.map((assignment) => assignment.theme_id));
        setSuggestedThemeIds([]);
      })
      .catch((loadError: unknown) => {
        if (active) setError(errorMessage(loadError));
      });
    fetchAiCapability()
      .then((nextCapability) => {
        if (active) setAiCapability(nextCapability);
      })
      .catch((capabilityError: unknown) => {
        if (active) setError(errorMessage(capabilityError));
      });
    return () => {
      active = false;
    };
  }, [symbol, tab]);

  const close = () => {
    requestRef.current?.abort();
    onClose();
  };

  const toggleTheme = (themeId: number) => {
    setSuggestedThemeIds((current) => current.filter((id) => id !== themeId));
    setDraftThemeIds((current) => {
      if (current.includes(themeId)) return current.filter((id) => id !== themeId);
      if (current.length >= 2) {
        setError("Assign at most two themes");
        return current;
      }
      return [...current, themeId];
    });
  };

  const saveManualThemes = async () => {
    setSavingThemes(true);
    try {
      await replaceTickerThemes(symbol, draftThemeIds);
      await loadThemes();
      onThemeChanged?.();
      setMessageSeverity("success");
      setMessage("Ticker themes updated");
    } catch (saveError) {
      setError(errorMessage(saveError));
    } finally {
      setSavingThemes(false);
    }
  };

  const suggestThemes = async () => {
    setSuggestingThemes(true);
    try {
      const selectedSymbol = symbol.toUpperCase();
      const nextSuggestions = (await suggestThemeAssignments([symbol])).filter(
        (suggestion) => suggestion.symbol === selectedSymbol,
      );
      setSuggestions(nextSuggestions);
      if (nextSuggestions.length === 0) {
        setDraftThemeIds([]);
        setSuggestedThemeIds([]);
        setMessageSeverity("warning");
        setMessage("AI suggested no themes");
        return;
      }
      const themeIds = nextSuggestions[0].themes
        .map((themeName) => themes.find((theme) => theme.name === themeName)?.id)
        .filter((themeId): themeId is number => themeId !== undefined);
      if (themeIds.length === 0) {
        setError("AI suggested themes that are not loaded in the UI");
        return;
      }
      setDraftThemeIds(themeIds);
      setSuggestedThemeIds(themeIds);
      setMessageSeverity("info");
      setMessage("AI suggestion selected. Save to apply.");
    } catch (suggestError) {
      setError(errorMessage(suggestError));
    } finally {
      setSuggestingThemes(false);
    }
  };

  return (
    <>
      <Dialog
        open
        onClose={close}
        maxWidth={false}
        slotProps={{ paper: { className: "ticker-details-dialog" } }}
      >
        <DialogTitle className="ticker-details-title">
          <div className="ticker-details-heading">
            <Typography component="h2">
              {details === undefined ? (
                symbol ?? "Ticker details"
              ) : (
                details.profile.name != null
                  ? `${details.profile.symbol} - ${details.profile.name}`
                  : details.profile.symbol
              )}
            </Typography>
            {details !== undefined && (
              <>
                <a href={tradingViewFinancialsUrl(details)} target="_blank" rel="noreferrer">
                  TradingView
                </a>
                <span aria-hidden="true">|</span>
                <a href={finvizFinancialsUrl(details)} target="_blank" rel="noreferrer">
                  Finviz
                </a>
              </>
            )}
          </div>
          <div className="ticker-details-actions">
            {details !== undefined && (
              <Typography color={details.stale_fundamentals ? "warning.main" : "text.secondary"}>
                {details.stale_fundamentals ? "Stale cache" : "Updated"}{" "}
                {new Date(details.fundamentals.fetched_at).toLocaleString()}
              </Typography>
            )}
            <IconButton
              aria-label="Refresh fundamentals"
              disabled={details === undefined || refreshing}
              onClick={refreshDetails}
            >
              {refreshing ? <CircularProgress size="1rem" /> : <RefreshIcon />}
            </IconButton>
          </div>
        </DialogTitle>
        <DialogContent className="ticker-details-content" dividers>
          {loading && details === undefined ? (
            <div className="panel-status">
              <CircularProgress size="1rem" />
              <Typography color="text.secondary">Loading ticker details</Typography>
            </div>
          ) : details !== undefined ? (
            <>
              <Tabs
                value={tab}
                onChange={(_, value: DetailsTab) => setTab(value)}
              >
                <Tab value="fundamentals" label="Fundamentals" />
                <Tab value="profile-themes" label="Profile / Themes" />
              </Tabs>
              {tab === "profile-themes" ? (
                <TickerProfileThemesTab
                  details={details}
                  themes={themes}
                  themeTicker={themeTicker}
                  draftThemeIds={draftThemeIds}
                  suggestedThemeIds={suggestedThemeIds}
                  aiCapability={aiCapability}
                  loading={themesLoading}
                  saving={savingThemes}
                  suggesting={suggestingThemes}
                  suggestions={suggestions}
                  onToggleTheme={toggleTheme}
                  onSave={saveManualThemes}
                  onSuggest={suggestThemes}
                />
              ) : (
                <TickerFundamentalsTab details={details} />
              )}
            </>
          ) : null}
        </DialogContent>
      </Dialog>
      <Toast message={error} onClose={() => setError(undefined)} />
      <Toast
        message={message}
        severity={messageSeverity}
        onClose={() => setMessage(undefined)}
      />
    </>
  );
}

function tradingViewFinancialsUrl(details: TickerDetails) {
  return `https://www.tradingview.com/symbols/${details.profile.exchange}-${details.profile.symbol}/financials-income-statement/?statements-period=FQ`;
}

function finvizFinancialsUrl(details: TickerDetails) {
  return `https://finviz.com/stock?t=${encodeURIComponent(details.profile.symbol)}&ty=ea&p=d&b=1`;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Request failed";
}

function isKeyboardInput(target: EventTarget | null) {
  return (
    target instanceof Element &&
    target.closest("input, textarea, select, [contenteditable='true'], [role='combobox'], [role='listbox']") !==
      null
  );
}
