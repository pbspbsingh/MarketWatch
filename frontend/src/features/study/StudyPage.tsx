import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import HorizontalSplitIcon from "@mui/icons-material/HorizontalSplit";
import VerticalSplitIcon from "@mui/icons-material/VerticalSplit";
import GpsFixedIcon from "@mui/icons-material/GpsFixed";
import VisibilityIcon from "@mui/icons-material/Visibility";
import VisibilityOffIcon from "@mui/icons-material/VisibilityOff";
import {
  Button,
  CircularProgress,
  IconButton,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from "@mui/material";
import type { MarketChartInterval } from "../../api/marketChart";
import {
  fetchLastStudy,
  fetchStudy,
  type StudyResult,
} from "../../api/study";
import {
  ImageExportMenu,
  type ImageExportAction,
} from "../../components/ImageExportMenu";
import { Toast } from "../../components/Toast";
import type { SplitOrientation } from "../../components/SplitPane";
import {
  copyElementAsPng,
  downloadElementAsPng,
} from "../../utils/exportElementImage";
import { StudyCharts } from "./StudyCharts";
import { shiftYears } from "./studyDates";
import "./study.css";

const todayText = localDateText(new Date());
const studyOrientationKey = "market-watch.study-orientation";
const studySplitKey = "market-watch.study-split";
const studyCrosshairSyncKey = "market-watch.study-crosshair-sync";
const studyTickerBVisibleKey = "market-watch.study-ticker-b-visible";
const studyIntervalKey = "market-watch.study-interval";

export function StudyPage() {
  const pageRef = useRef<HTMLElement>(null);
  const [symbolA, setSymbolA] = useState("SPY");
  const [symbolB, setSymbolB] = useState("QQQ");
  const [date, setDate] = useState(todayText);
  const [interval, setInterval] = useState<MarketChartInterval>(
    () => localStorage.getItem(studyIntervalKey) === "weekly" ? "weekly" : "daily",
  );
  const [result, setResult] = useState<StudyResult>();
  const [datasetVersion, setDatasetVersion] = useState(0);
  const [loading, setLoading] = useState(true);
  const [orientation, setOrientation] = useState<SplitOrientation>(() =>
    localStorage.getItem(studyOrientationKey) === "horizontal" ? "horizontal" : "vertical",
  );
  const [crosshairSync, setCrosshairSync] = useState(
    () => localStorage.getItem(studyCrosshairSyncKey) === "true",
  );
  const [tickerBVisible, setTickerBVisible] = useState(
    () => localStorage.getItem(studyTickerBVisibleKey) !== "false",
  );
  const [error, setError] = useState<string>();
  const [captureNotice, setCaptureNotice] = useState<{
    message: string;
    severity: "success" | "error";
  }>();
  const [exporting, setExporting] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const requestRef = useRef<AbortController | undefined>(undefined);
  const historyRequestRef = useRef<AbortController | undefined>(undefined);
  const resultRef = useRef(result);

  useEffect(() => {
    resultRef.current = result;
  }, [result]);

  useEffect(() => {
    const controller = new AbortController();
    fetchLastStudy(controller.signal)
      .then((last) => {
        if (last === null) return;
        resultRef.current = last;
        setResult(last);
        setDate(last.date);
        setInterval(last.interval);
        setSymbolA(last.series[0]?.symbol ?? "SPY");
        setSymbolB(last.series[1]?.symbol ?? "QQQ");
      })
      .catch((loadError: unknown) => {
        if (loadError instanceof Error && loadError.name !== "AbortError") setError(loadError.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, []);

  useEffect(() => () => {
    requestRef.current?.abort();
    historyRequestRef.current?.abort();
  }, []);

  const load = async (refresh: boolean) => {
    const validationError = validateInputs(symbolA, symbolB, date);
    if (validationError !== undefined) {
      setError(validationError);
      return;
    }
    requestRef.current?.abort();
    historyRequestRef.current?.abort();
    historyRequestRef.current = undefined;
    setHistoryLoading(false);
    const controller = new AbortController();
    requestRef.current = controller;
    setLoading(true);
    setError(undefined);
    try {
      const next = await fetchStudy(
        [symbolA.trim().toUpperCase(), symbolB.trim().toUpperCase()],
        date,
        interval,
        { refresh, signal: controller.signal },
      );
      resultRef.current = next;
      setResult(next);
      setDatasetVersion((version) => version + 1);
      setSymbolA(next.series[0]?.symbol ?? symbolA);
      setSymbolB(next.series[1]?.symbol ?? symbolB);
    } catch (loadError) {
      if (loadError instanceof Error && loadError.name !== "AbortError") setError(loadError.message);
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  };

  const loadHistory = async (direction: "before" | "after") => {
    const current = resultRef.current;
    if (
      current === undefined
      || historyRequestRef.current !== undefined
      || direction === "before" && !current.has_more_before
      || direction === "after" && !current.has_more_after
    ) return;

    const range = direction === "before"
      ? { start: shiftYears(current.range_start, -1), end: current.range_end }
      : { start: current.range_start, end: shiftYears(current.range_end, 1) };
    const fetchRange = direction === "before"
      ? { start: range.start, end: current.range_start }
      : { start: current.range_end, end: range.end };
    const requestKey = studyResultKey(current);
    const controller = new AbortController();
    historyRequestRef.current = controller;
    setHistoryLoading(true);
    try {
      const expanded = await fetchStudy(
        [current.series[0].symbol, current.series[1].symbol],
        current.date,
        current.interval,
        { range, fetchRange, signal: controller.signal },
      );
      if (
        !controller.signal.aborted
        && resultRef.current !== undefined
        && studyResultKey(resultRef.current) === requestKey
      ) {
        resultRef.current = expanded;
        setResult(expanded);
      }
    } catch (historyError) {
      if (!(historyError instanceof Error && historyError.name === "AbortError")) {
        setError(historyError instanceof Error
          ? `Unable to load ${direction === "before" ? "earlier" : "later"} history: ${historyError.message}`
          : `Unable to load ${direction === "before" ? "earlier" : "later"} history`);
      }
    } finally {
      if (historyRequestRef.current === controller) {
        historyRequestRef.current = undefined;
        setHistoryLoading(false);
      }
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void load(false);
  };

  const changeInterval = async (nextInterval: MarketChartInterval) => {
    setInterval(nextInterval);
    localStorage.setItem(studyIntervalKey, nextInterval);
    const current = resultRef.current;
    if (current === undefined || current.interval === nextInterval) return;

    requestRef.current?.abort();
    historyRequestRef.current?.abort();
    historyRequestRef.current = undefined;
    setHistoryLoading(false);
    const controller = new AbortController();
    requestRef.current = controller;
    setLoading(true);
    setError(undefined);
    try {
      const next = await fetchStudy(
        [current.series[0].symbol, current.series[1].symbol],
        current.date,
        nextInterval,
        {
          range: { start: current.range_start, end: current.range_end },
          signal: controller.signal,
        },
      );
      if (!controller.signal.aborted && requestRef.current === controller) {
        resultRef.current = next;
        setResult(next);
      }
    } catch (loadError) {
      if (loadError instanceof Error && loadError.name !== "AbortError") {
        setInterval(current.interval);
        localStorage.setItem(studyIntervalKey, current.interval);
        setError(loadError.message);
      }
    } finally {
      if (!controller.signal.aborted && requestRef.current === controller) setLoading(false);
    }
  };

  const changeDate = (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const rawValue = input.value;
    const rawCaret = input.selectionStart ?? rawValue.length;
    const nextDate = formatDateInput(rawValue);
    const nextCaret = dateCaretPosition(rawValue, rawCaret, nextDate);
    setDate(nextDate);
    window.requestAnimationFrame(() => {
      if (document.activeElement === input) input.setSelectionRange(nextCaret, nextCaret);
    });
  };

  const handleDateKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (!(event.target instanceof HTMLInputElement)) return;
    const input = event.target;
    const start = input.selectionStart;
    const end = input.selectionEnd;
    if (start === null || end === null || start !== end) return;
    if (event.key === "Backspace" && input.value[start - 1] === "-") {
      event.preventDefault();
      input.setSelectionRange(start - 1, start - 1);
    } else if (event.key === "Delete" && input.value[start] === "-") {
      event.preventDefault();
      input.setSelectionRange(start + 1, start + 1);
    }
  };

  const exportStudy = async (action: ImageExportAction) => {
    const page = pageRef.current;
    if (page === null || result === undefined || exporting) return;

    setExporting(true);
    setCaptureNotice(undefined);
    try {
      if (action === "copy") {
        await copyElementAsPng(page);
      } else {
        const firstTicker = result.series[0]?.symbol ?? symbolA.trim().toUpperCase();
        const secondTicker = result.series[1]?.symbol ?? symbolB.trim().toUpperCase();
        const filename = tickerBVisible
          ? `${firstTicker}-${secondTicker}.png`
          : `${firstTicker}.png`;
        await downloadElementAsPng(page, filename);
      }
      setCaptureNotice({
        message: action === "copy" ? "Study copied as an image" : "Study downloaded",
        severity: "success",
      });
    } catch (captureError) {
      setCaptureNotice({
        message: captureError instanceof Error
          ? `Unable to ${action} study: ${captureError.message}`
          : `Unable to ${action} study`,
        severity: "error",
      });
    } finally {
      setExporting(false);
    }
  };

  return (
    <section ref={pageRef} className="study-page">
      <form className="study-header" onSubmit={submit}>
        <Typography component="h1">Study</Typography>
        <TextField
          size="small"
          label="Ticker A"
          value={symbolA}
          onChange={(event) => setSymbolA(event.target.value)}
          onFocus={(event) => event.currentTarget.select()}
        />
        <TextField
          size="small"
          label="Ticker B"
          value={symbolB}
          onChange={(event) => setSymbolB(event.target.value)}
          onFocus={(event) => event.currentTarget.select()}
        />
        <TextField
          size="small"
          label="Date"
          placeholder="YYYY-MM-DD"
          value={date}
          slotProps={{ htmlInput: { inputMode: "numeric" } }}
          onChange={changeDate}
          onKeyDown={handleDateKeyDown}
        />
        <ToggleButtonGroup
          className="study-interval-toggle"
          disabled={loading}
          exclusive
          size="small"
          value={interval}
          aria-label="Study chart interval"
          onChange={(_, nextInterval: MarketChartInterval | null) => {
            if (nextInterval !== null) void changeInterval(nextInterval);
          }}
        >
          <ToggleButton value="daily">Daily</ToggleButton>
          <ToggleButton value="weekly">Weekly</ToggleButton>
        </ToggleButtonGroup>
        <Button size="small" variant="contained" type="submit" disabled={loading}>Load</Button>
        <Button size="small" variant="outlined" type="button" disabled={loading || result === undefined} onClick={() => void load(true)}>Refresh</Button>
        {loading && <CircularProgress size="1rem" />}
        <Tooltip title={orientation === "vertical" ? "Switch to side-by-side" : "Switch to top/bottom"}>
          <IconButton
            className="study-layout-toggle"
            size="small"
            type="button"
            aria-label={orientation === "vertical" ? "Switch to side-by-side charts" : "Switch to top and bottom charts"}
            onClick={() => setOrientation((current) => {
              const next = current === "vertical" ? "horizontal" : "vertical";
              localStorage.setItem(studyOrientationKey, next);
              return next;
            })}
          >
            {orientation === "vertical" ? <VerticalSplitIcon fontSize="small" /> : <HorizontalSplitIcon fontSize="small" />}
          </IconButton>
        </Tooltip>
        <Tooltip title={`${crosshairSync ? "Disable" : "Enable"} synchronized crosshair`}>
          <IconButton
            size="small"
            type="button"
            color={crosshairSync ? "primary" : "default"}
            aria-label={`${crosshairSync ? "Disable" : "Enable"} synchronized crosshair`}
            aria-pressed={crosshairSync}
            onClick={() => setCrosshairSync((enabled) => {
              const next = !enabled;
              localStorage.setItem(studyCrosshairSyncKey, String(next));
              return next;
            })}
          >
            <GpsFixedIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <Tooltip title={`${tickerBVisible ? "Hide" : "Show"} Ticker B chart`}>
          <IconButton
            size="small"
            type="button"
            color={tickerBVisible ? "default" : "primary"}
            aria-label={`${tickerBVisible ? "Hide" : "Show"} Ticker B chart`}
            aria-pressed={!tickerBVisible}
            onClick={() => setTickerBVisible((visible) => {
              const next = !visible;
              localStorage.setItem(studyTickerBVisibleKey, String(next));
              return next;
            })}
          >
            {tickerBVisible ? <VisibilityIcon fontSize="small" /> : <VisibilityOffIcon fontSize="small" />}
          </IconButton>
        </Tooltip>
        <ImageExportMenu
          disabled={result === undefined}
          busy={exporting}
          onSelect={(action) => void exportStudy(action)}
        />
      </form>
      <div className="study-body">
        {result === undefined ? (
          <div className="panel-status">
            <Typography color="text.secondary">Enter two tickers and a historical date</Typography>
          </div>
        ) : (
          <StudyCharts
            result={result}
            datasetVersion={datasetVersion}
            orientation={orientation}
            initialSplit={readStudySplit()}
            onSplitChange={(split) => localStorage.setItem(studySplitKey, String(split))}
            syncCrosshair={crosshairSync}
            tickerBVisible={tickerBVisible}
            historyLoading={historyLoading}
            onRequestHistory={(direction) => void loadHistory(direction)}
          />
        )}
      </div>
      <a className="study-attribution" href="https://www.tradingview.com/" target="_blank" rel="noreferrer">
        Charts by TradingView
      </a>
      <Toast message={error} onClose={() => setError(undefined)} />
      <Toast
        message={captureNotice?.message}
        severity={captureNotice?.severity}
        onClose={() => setCaptureNotice(undefined)}
      />
    </section>
  );
}

function readStudySplit() {
  const storedValue = localStorage.getItem(studySplitKey);
  if (storedValue === null) return 50;
  const value = Number(storedValue);
  return Number.isFinite(value) && value >= 0 && value <= 100 ? value : 50;
}

function validateInputs(symbolA: string, symbolB: string, dateText: string) {
  const symbolPattern = /^[A-Za-z0-9.-]+$/;
  const first = symbolA.trim().toUpperCase();
  const second = symbolB.trim().toUpperCase();
  if (!symbolPattern.test(first) || !symbolPattern.test(second)) return "Enter two valid ticker symbols";
  if (first === second) return "Ticker A and Ticker B must be different";
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateText);
  if (match === null) return "Date must use YYYY-MM-DD";
  const selected = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (localDateText(selected) !== dateText) return "Enter a valid calendar date";
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (selected > today) return "Date cannot be in the future";
  return undefined;
}

function localDateText(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function studyResultKey(result: StudyResult) {
  return `${result.series[0]?.symbol ?? ""}\0${result.series[1]?.symbol ?? ""}\0${result.date}\0${result.interval}`;
}

function formatDateInput(value: string) {
  const parts = value.split("-");
  if (parts.length === 1) return formatDateDigits(digitsOnly(value));

  const yearDigits = digitsOnly(parts[0]);
  const year = yearDigits.slice(0, 4);
  let overflow = yearDigits.slice(4);

  const monthDigits = overflow + digitsOnly(parts[1] ?? "");
  const month = monthDigits.slice(0, 2);
  overflow = monthDigits.slice(2);

  const day = (overflow + digitsOnly(parts.slice(2).join(""))).slice(0, 2);
  const firstSeparator = parts.length > 1 || year.length === 4 ? "-" : "";
  const secondSeparator = parts.length > 2 || month.length === 2 ? "-" : "";
  return `${year}${firstSeparator}${month}${secondSeparator}${day}`;
}

function formatDateDigits(digits: string) {
  const value = digits.slice(0, 8);
  const year = value.slice(0, 4);
  const month = value.slice(4, 6);
  const day = value.slice(6, 8);
  return `${year}${value.length >= 4 ? "-" : ""}${month}${value.length >= 6 ? "-" : ""}${day}`;
}

function dateCaretPosition(rawValue: string, rawCaret: number, formattedValue: string) {
  const prefix = rawValue.slice(0, rawCaret);
  const separatorCount = prefix.length - prefix.replaceAll("-", "").length;
  if (separatorCount === 0) {
    const digitCount = digitsOnly(prefix).length;
    const rawSeparator = rawValue.indexOf("-");
    if (rawSeparator !== -1 && rawCaret <= rawSeparator) return digitCount;
    return caretAfterDigits(formattedValue, digitCount);
  }

  const digitsInSegment = digitsOnly(prefix.slice(prefix.lastIndexOf("-") + 1)).length;
  const firstSeparator = formattedValue.indexOf("-");
  if (separatorCount === 1) {
    const secondSeparator = formattedValue.indexOf("-", firstSeparator + 1);
    if (digitsInSegment >= 2 && secondSeparator !== -1) return secondSeparator + 1;
    const monthEnd = secondSeparator === -1 ? formattedValue.length : secondSeparator;
    return Math.min(firstSeparator + 1 + digitsInSegment, monthEnd);
  }

  const secondSeparator = formattedValue.indexOf("-", firstSeparator + 1);
  return Math.min(secondSeparator + 1 + digitsInSegment, formattedValue.length);
}

function caretAfterDigits(value: string, digitCount: number) {
  if (digitCount === 0) return 0;
  let seen = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (/\d/.test(value[index])) seen += 1;
    if (seen !== digitCount) continue;
    let caret = index + 1;
    while (value[caret] === "-") caret += 1;
    return caret;
  }
  return value.length;
}

function digitsOnly(value: string) {
  return value.replace(/\D/g, "");
}
