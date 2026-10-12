import { useEffect, useState } from "react";
import { CircularProgress, Typography } from "@mui/material";
import { fetchLastStudy, type StudyResult } from "../../api/study";
import type { ChartSyncTarget } from "../../components/lightweight-chart/chartSync";
import { MarketChart } from "../charts/MarketChart";

export function StudyWeeklyChart({
  result,
  showAxes,
  onChartContext,
}: {
  result: StudyResult;
  showAxes: boolean;
  onChartContext: (context: ChartSyncTarget | null) => void;
}) {
  const [loaded, setLoaded] = useState<{
    request: StudyResult;
    weekly?: StudyResult;
    error?: string;
  }>();
  const current = loaded?.request === result ? loaded : undefined;
  const series = current?.weekly?.series[0];

  useEffect(() => {
    const controller = new AbortController();
    // The backend aggregates the same cached daily dataset used by the study.
    void fetchLastStudy("weekly", controller.signal).then((weekly) => {
      if (controller.signal.aborted) return;
      if (weekly === null || weekly.date !== result.date
        || weekly.range_start !== result.range_start || weekly.range_end !== result.range_end
        || weekly.series.length !== result.series.length
        || weekly.series.some((item, index) => item.symbol !== result.series[index]?.symbol)) {
        throw new Error("Weekly chart does not match the loaded study. Reload the study to retry.");
      }
      setLoaded({ request: result, weekly });
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setLoaded({
        request: result,
        error: error instanceof Error ? error.message : "Unable to load weekly study chart",
      });
    });
    return () => controller.abort();
  }, [result]);

  if (current?.error !== undefined) return (
    <div className="panel-status" role="alert"><Typography color="error">{current.error}</Typography></div>
  );
  if (series === undefined) return (
    <div className="panel-status"><CircularProgress size="1rem" /></div>
  );
  const markerDate = series.candles.findLast((candle) => candle.date <= result.date)?.date;
  return (
    <MarketChart
      data={{ ...series, interval: "weekly" }}
      companyName={series.company_name ?? undefined}
      rightPriceScaleVisible={showAxes}
      timeScaleVisible={showAxes}
      rightOffsetPixels={10}
      attributionLogo={false}
      onChartContext={onChartContext}
      markers={markerDate === undefined ? [] : [{ date: markerDate, kind: "exit", text: result.date }]}
    />
  );
}
