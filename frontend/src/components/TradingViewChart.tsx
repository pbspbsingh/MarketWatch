import { useEffect, useId, useRef } from "react";

interface TradingViewWindow extends Window {
  TradingView?: {
    widget: new (options: TradingViewWidgetOptions) => TradingViewWidget;
  };
}

interface TradingViewWidgetOptions extends Record<string, unknown> {
  symbol: string;
  interval: "D" | "W";
}

interface TradingViewWidget {
  id: string;
  options: TradingViewWidgetOptions;
  reload: () => void;
  remove: () => void;
}

interface TradingViewChartProps {
  symbol: string;
  interval: "D" | "W";
  onError: (message: string) => void;
}

const scriptUrl = "https://s3.tradingview.com/tv.js";
let scriptPromise: Promise<void> | undefined;

function loadTradingView() {
  if ((window as TradingViewWindow).TradingView !== undefined) return Promise.resolve();
  scriptPromise ??= new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = scriptUrl;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Failed to load TradingView chart library"));
    document.head.append(script);
  }).catch((error: unknown) => {
    scriptPromise = undefined;
    throw error;
  });
  return scriptPromise;
}

export function TradingViewChart({ symbol, interval, onError }: TradingViewChartProps) {
  const containerId = `tradingview-${useId().replaceAll(":", "")}`;
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetRef = useRef<TradingViewWidget | undefined>(undefined);
  const requestedChart = useRef({ symbol, interval });
  requestedChart.current = { symbol, interval };

  useEffect(() => {
    let active = true;
    loadTradingView()
      .then(() => {
        const TradingView = (window as TradingViewWindow).TradingView;
        if (!active || TradingView === undefined) return;
        const requested = requestedChart.current;
        widgetRef.current = new TradingView.widget({
          width: "100%",
          height: "100%",
          symbol: requested.symbol,
          interval: requested.interval,
          timezone: "America/Los_Angeles",
          theme: "dark",
          style: "1",
          locale: "en",
          toolbar_bg: "#1e1e1e",
          enable_publishing: false,
          container_id: containerId,
          studies: ["MASimple@tv-basicstudies", "STD;MA%Ribbon"],
          studies_overrides: {
            "moving average.length": 10,
            "moving average.ma.color": "#5693e7",
          },
          loading_screen: { backgroundColor: "#1e1e1e" },
        });
      })
      .catch((error: unknown) => {
        onError(error instanceof Error ? error.message : "Failed to load TradingView chart");
      });

    return () => {
      active = false;
      const widget = widgetRef.current;
      const iframe = widget === undefined ? null : document.getElementById(widget.id);
      if (widget !== undefined && iframe?.parentNode !== undefined && iframe.parentNode !== null) {
        widget.remove();
      }
      widgetRef.current = undefined;
      containerRef.current?.replaceChildren();
    };
  }, [containerId, onError]);

  useEffect(() => {
    const widget = widgetRef.current;
    if (
      widget === undefined ||
      (widget.options.symbol === symbol && widget.options.interval === interval)
    ) {
      return;
    }
    widget.options.symbol = symbol;
    widget.options.interval = interval;
    widget.reload();
  }, [interval, symbol]);

  return <div ref={containerRef} className="tradingview-chart" id={containerId} />;
}
