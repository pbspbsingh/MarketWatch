import { useEffect, useRef, useState, type FormEvent } from "react";
import HorizontalSplitIcon from "@mui/icons-material/HorizontalSplit";
import VerticalSplitIcon from "@mui/icons-material/VerticalSplit";
import GpsFixedIcon from "@mui/icons-material/GpsFixed";
import VisibilityIcon from "@mui/icons-material/Visibility";
import VisibilityOffIcon from "@mui/icons-material/VisibilityOff";
import { Button, CircularProgress, IconButton, TextField, Tooltip, Typography } from "@mui/material";
import { fetchLastStudy, fetchStudy, type StudyResult } from "../../api/study";
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
import "./study.css";

const todayText = localDateText(new Date());
const studyOrientationKey = "market-watch.study-orientation";
const studyCrosshairSyncKey = "market-watch.study-crosshair-sync";
const studyTickerBVisibleKey = "market-watch.study-ticker-b-visible";

export function StudyPage() {
  const pageRef = useRef<HTMLElement>(null);
  const [symbolA, setSymbolA] = useState("SPY");
  const [symbolB, setSymbolB] = useState("QQQ");
  const [date, setDate] = useState(todayText);
  const [result, setResult] = useState<StudyResult>();
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
  const requestRef = useRef<AbortController | undefined>(undefined);

  useEffect(() => {
    const controller = new AbortController();
    fetchLastStudy(controller.signal)
      .then((last) => {
        if (last === null) return;
        setResult(last);
        setDate(last.date);
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

  useEffect(() => () => requestRef.current?.abort(), []);

  const load = async (refresh: boolean) => {
    const validationError = validateInputs(symbolA, symbolB, date);
    if (validationError !== undefined) {
      setError(validationError);
      return;
    }
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setLoading(true);
    setError(undefined);
    try {
      const next = await fetchStudy(
        [symbolA.trim().toUpperCase(), symbolB.trim().toUpperCase()],
        date,
        refresh,
        controller.signal,
      );
      setResult(next);
      setSymbolA(next.series[0]?.symbol ?? symbolA);
      setSymbolB(next.series[1]?.symbol ?? symbolB);
    } catch (loadError) {
      if (loadError instanceof Error && loadError.name !== "AbortError") setError(loadError.message);
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void load(false);
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
        <TextField size="small" label="Ticker A" value={symbolA} onChange={(event) => setSymbolA(event.target.value)} />
        <TextField size="small" label="Ticker B" value={symbolB} onChange={(event) => setSymbolB(event.target.value)} />
        <TextField size="small" label="Date" placeholder="YYYY-MM-DD" value={date} onChange={(event) => setDate(event.target.value)} />
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
            orientation={orientation}
            syncCrosshair={crosshairSync}
            tickerBVisible={tickerBVisible}
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
  const earliest = new Date(today);
  earliest.setFullYear(earliest.getFullYear() - 10);
  if (selected < earliest || selected > today) return "Date must be within the previous ten years";
  return undefined;
}

function localDateText(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
