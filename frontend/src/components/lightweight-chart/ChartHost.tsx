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
import { baseChartOptions } from "./chartOptions";

export interface ChartHostHandle {
  getChart: () => IChartApi | null;
}

interface ChartHostProps {
  className?: string;
  ariaLabel?: string;
  options?: DeepPartial<ChartOptions>;
  onChartReady?: (chart: IChartApi) => void;
  onChartDestroy?: (chart: IChartApi) => void;
}

export const ChartHost = forwardRef<ChartHostHandle, ChartHostProps>(
  function ChartHost({ className, ariaLabel, options, onChartReady, onChartDestroy }, ref) {
    const containerRef = useRef<HTMLDivElement>(null);
    const chartRef = useRef<IChartApi>(null);
    const onChartReadyRef = useRef(onChartReady);
    const onChartDestroyRef = useRef(onChartDestroy);
    onChartReadyRef.current = onChartReady;
    onChartDestroyRef.current = onChartDestroy;

    useImperativeHandle(ref, () => ({
      getChart: () => chartRef.current,
    }), []);

    useLayoutEffect(() => {
      const container = containerRef.current;
      if (container === null) return;

      const chart = createChart(container, baseChartOptions);
      chartRef.current = chart;
      onChartReadyRef.current?.(chart);

      return () => {
        try {
          onChartDestroyRef.current?.(chart);
        } finally {
          chartRef.current = null;
          chart.remove();
        }
      };
    }, []);

    useEffect(() => {
      if (options !== undefined) chartRef.current?.applyOptions(options);
    }, [options]);

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
