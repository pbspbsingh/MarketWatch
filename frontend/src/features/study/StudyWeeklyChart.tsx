import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CircularProgress, Typography } from "@mui/material";
import type { StudyResult } from "../../api/study";
import type { ChartSyncTarget } from "../../components/lightweight-chart/chartSync";
import { useAppSettings, useRelativeStrengthPeriod } from "../../app/AppSettings";
import { displayedStudyResult, studyQueryOptions, studySelection } from "./studyQuery";
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
  const { showWeeklyOverlayRelativeStrength } = useAppSettings();
  const period = useRelativeStrengthPeriod("weekly");
  const client = useQueryClient();
  const request = { ...studySelection(result), interval: "weekly" as const, period };
  const query = useQuery(studyQueryOptions(client, request));
  const weekly = displayedStudyResult(client, request, query.data);
  const series = weekly?.interval === "weekly" ? weekly.series[0] : undefined;

  if (query.isError && series === undefined) return (
    <div className="panel-status" role="alert"><Typography color="error">{query.error instanceof Error ? query.error.message : "Unable to load weekly Study"}</Typography></div>
  );
  if (series === undefined) return (
    <div className="panel-status"><CircularProgress size="1rem" /></div>
  );
  const markerDate = series.candles.findLast((candle) => candle.date <= result.date)?.date;
  return (
    <>
      {query.isError && <div className="weekly-chart-overlay-error" role="alert">Unable to refresh weekly Study. Showing cached prices.</div>}
      <MarketChart
        data={{ ...series, interval: "weekly" }}
        relativeStrength={weekly?.relative_strength}
        showRelativeStrength={showWeeklyOverlayRelativeStrength}
        companyName={series.company_name ?? undefined}
        rightPriceScaleVisible={showAxes}
        timeScaleVisible={showAxes}
        rightOffsetPixels={10}
        attributionLogo={false}
        onChartContext={onChartContext}
        dateMarkers={markerDate === undefined ? [] : [{ date: markerDate, text: result.date }]}
      />
    </>
  );
}
