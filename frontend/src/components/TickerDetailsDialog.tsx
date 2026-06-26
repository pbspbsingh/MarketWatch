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
  const [loading, setLoading] = useState(false);
  const [themesLoading, setThemesLoading] = useState(false);
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
  const symbolRef = useRef(symbol);

  useEffect(() => {
    symbolRef.current = symbol;
  }, [symbol]);

  useEffect(() => {
    if (open) {
      setTab("fundamentals");
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
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
  }, [open]);

  const load = (refresh: boolean) => {
    if (symbol === undefined) return undefined;
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    refresh ? setRefreshing(true) : setLoading(true);
    fetchTickerDetails(symbol, refresh, controller.signal)
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
    return controller;
  };

  const loadThemes = async (targetSymbol: string) => {
    setThemesLoading(true);
    try {
      const [nextThemes, nextTicker] = await Promise.all([
        fetchThemes(),
        fetchThemeTicker(targetSymbol),
      ]);
      if (symbolRef.current !== targetSymbol) return;
      setThemes(nextThemes);
      setThemeTicker(nextTicker);
      setDraftThemeIds(nextTicker.assignments.map((assignment) => assignment.theme_id));
      setSuggestedThemeIds([]);
    } catch (loadError) {
      if (symbolRef.current === targetSymbol) {
        setError(errorMessage(loadError));
      }
    } finally {
      if (symbolRef.current === targetSymbol) {
        setThemesLoading(false);
      }
    }
  };

  useEffect(() => {
    if (!open || symbol === undefined) return;
    setDetails(undefined);
    setThemeTicker(undefined);
    setDraftThemeIds([]);
    setSuggestedThemeIds([]);
    setSuggestions([]);
    setError(undefined);
    const controller = load(false);
    return () => controller?.abort();
  }, [open, symbol]);

  useEffect(() => {
    if (!open || symbol === undefined || tab !== "profile-themes") return;
    void loadThemes(symbol);
    fetchAiCapability()
      .then(setAiCapability)
      .catch((capabilityError: unknown) => setError(errorMessage(capabilityError)));
  }, [open, symbol, tab]);

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
    if (symbol === undefined) return;
    setSavingThemes(true);
    try {
      await replaceTickerThemes(symbol, draftThemeIds);
      await loadThemes(symbol);
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
    if (symbol === undefined) return;
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
        open={open}
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
              onClick={() => load(true)}
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
