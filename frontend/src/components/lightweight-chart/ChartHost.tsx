import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  type MouseEventHandler,
} from "react";
import {
  createChart,
  PriceScaleMode,
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
  useGlobalPriceScale?: boolean;
  attributionUrl?: string;
  onContextMenu?: MouseEventHandler<HTMLDivElement>;
  onChartReady?: (chart: IChartApi) => void;
  onChartDestroy?: (chart: IChartApi) => void;
}

export const ChartHost = forwardRef<ChartHostHandle, ChartHostProps>(
  function ChartHost({
    className,
    ariaLabel,
    options,
    useGlobalPriceScale = false,
    attributionUrl,
    onContextMenu,
    onChartReady,
    onChartDestroy,
  }, ref) {
    const { theme, gridOpacity, logarithmicScale } = useAppSettings();
    const containerRef = useRef<HTMLDivElement>(null);
    const chartRef = useRef<IChartApi>(null);
    const initialThemeRef = useRef(theme);
    const initialGridOpacityRef = useRef(gridOpacity);
    const onChartReadyRef = useRef(onChartReady);
    const onChartDestroyRef = useRef(onChartDestroy);
    const attributionUrlRef = useRef(attributionUrl);
    useLayoutEffect(() => {
      onChartReadyRef.current = onChartReady;
      onChartDestroyRef.current = onChartDestroy;
      attributionUrlRef.current = attributionUrl;
    }, [onChartReady, onChartDestroy, attributionUrl]);

    useImperativeHandle(ref, () => ({
      getChart: () => chartRef.current,
    }), []);

    useLayoutEffect(() => {
      const container = containerRef.current;
      if (container === null) return;

      const chart = createChart(container, baseChartOptions(
        initialThemeRef.current,
        initialGridOpacityRef.current,
      ));
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
      chartRef.current?.applyOptions(chartThemeOptions(theme, gridOpacity));
    }, [theme, gridOpacity]);

    useEffect(() => {
      if (options !== undefined) chartRef.current?.applyOptions(options);
    }, [options]);

    useEffect(() => {
      if (useGlobalPriceScale) {
        chartRef.current?.priceScale("right").applyOptions({
          mode: logarithmicScale ? PriceScaleMode.Logarithmic : PriceScaleMode.Normal,
        });
      }
    }, [useGlobalPriceScale, logarithmicScale]);

    useEffect(() => {
      const container = containerRef.current;
      if (container !== null) updateAttributionUrl(container, attributionUrl);
    }, [attributionUrl]);

    return (
      <div
        ref={containerRef}
        onContextMenu={onContextMenu}
        className={className}
        aria-label={ariaLabel}
        style={{ width: "100%", height: "100%", minWidth: 0, minHeight: 0 }}
      />
    );
  },
);

export function updateAttributionUrl(container: HTMLElement, url: string | undefined) {
  if (url === undefined) return;
  const logo = container.querySelector<HTMLAnchorElement>("#tv-attr-logo");
  if (logo === null) return;
  logo.href = url;
  logo.rel = "noopener noreferrer";
}
