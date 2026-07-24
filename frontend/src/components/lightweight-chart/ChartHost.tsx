import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
} from "react";
import {
  createChart,
  type ChartOptions,
  type DeepPartial,
  type IChartApi,
} from "lightweight-charts";
import { baseChartOptions, chartThemeOptions } from "./chartOptions";
import { useAppSettings } from "../../app/AppSettings";

export interface ChartHostHandle {
  getChart: () => IChartApi | null;
}

interface ChartHostProps {
  className?: string;
  ariaLabel?: string;
  options?: DeepPartial<ChartOptions>;
  attributionUrl?: string;
  onChartReady?: (chart: IChartApi) => void;
  onChartDestroy?: (chart: IChartApi) => void;
}

export const ChartHost = forwardRef<ChartHostHandle, ChartHostProps>(
  function ChartHost({
    className,
    ariaLabel,
    options,
    attributionUrl,
    onChartReady,
    onChartDestroy,
  }, ref) {
    const { theme } = useAppSettings();
    const containerRef = useRef<HTMLDivElement>(null);
    const chartRef = useRef<IChartApi>(null);
    const initialThemeRef = useRef(theme);
    const onChartReadyRef = useRef(onChartReady);
    const onChartDestroyRef = useRef(onChartDestroy);
    const attributionUrlRef = useRef(attributionUrl);
    onChartReadyRef.current = onChartReady;
    onChartDestroyRef.current = onChartDestroy;
    attributionUrlRef.current = attributionUrl;

    useImperativeHandle(ref, () => ({
      getChart: () => chartRef.current,
    }), []);

    useLayoutEffect(() => {
      const container = containerRef.current;
      if (container === null) return;

      const chart = createChart(container, baseChartOptions(initialThemeRef.current));
      const observer = new MutationObserver(() => {
        updateAttributionUrl(container, attributionUrlRef.current);
      });
      observer.observe(container, { childList: true, subtree: true });
      updateAttributionUrl(container, attributionUrlRef.current);
      chartRef.current = chart;
      onChartReadyRef.current?.(chart);

      return () => {
        observer.disconnect();
        try {
          onChartDestroyRef.current?.(chart);
        } finally {
          chartRef.current = null;
          chart.remove();
        }
      };
    }, []);

    useEffect(() => {
      chartRef.current?.applyOptions(chartThemeOptions(theme));
    }, [theme]);

    useEffect(() => {
      if (options !== undefined) chartRef.current?.applyOptions(options);
    }, [options]);

    useEffect(() => {
      const container = containerRef.current;
      if (container !== null) updateAttributionUrl(container, attributionUrl);
    }, [attributionUrl]);

    return (
      <div
        ref={containerRef}
        className={className}
        aria-label={ariaLabel}
        style={{ width: "100%", height: "100%", minWidth: 0, minHeight: 0 }}
      />
    );
  },
);

function updateAttributionUrl(container: HTMLElement, url: string | undefined) {
  if (url === undefined) return;
  const logo = container.querySelector<HTMLAnchorElement>("#tv-attr-logo");
  if (logo === null) return;
  logo.href = url;
  logo.rel = "noopener noreferrer";
}
