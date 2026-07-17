import {
  marketDataSymbol,
  type MarketChartCandle,
  type MarketChartInterval,
  type MarketChartRelativeStrength,
  type MarketChartSeries,
} from "./marketChart";

export interface MarketChartLiveRequest {
  chart_id: string;
  symbol: string;
  interval: MarketChartInterval;
  comparison_symbol?: string;
}

export interface MarketChartLiveDelta {
  chart_id: string;
  symbol: string;
  interval: MarketChartInterval;
  candle: MarketChartCandle;
  moving_averages: MarketChartSeries[];
  volume_average: MarketChartSeries;
  relative_strength: MarketChartRelativeStrength | null;
}

export interface MarketChartSessionDelta {
  chart_id: string;
  symbol: string;
  session: "pre_market" | "post_market";
  candle: MarketChartCandle | null;
  price: number;
}

interface LiveChartClientOptions {
  onDelta: (delta: MarketChartLiveDelta) => void;
  onSession: (delta: MarketChartSessionDelta) => void;
  onError: (message: string) => void;
}

type LiveChartEvent =
  | { type: "subscribed"; request_id: number; symbols: string[] }
  | { type: "delta"; request_id: number; delta: MarketChartLiveDelta }
  | { type: "session"; request_id: number; delta: MarketChartSessionDelta }
  | { type: "error"; request_id: number; message: string };

const initialReconnectDelayMs = 1_000;
const maximumReconnectDelayMs = 30_000;

export class MarketChartLiveClient {
  private socket?: WebSocket;
  private reconnectTimer?: number;
  private reconnectDelayMs = initialReconnectDelayMs;
  private requestId = 0;
  private charts: MarketChartLiveRequest[] = [];
  private serializedCharts = "";
  private closed = false;

  constructor(private readonly options: LiveChartClientOptions) {}

  setCharts(charts: MarketChartLiveRequest[]) {
    const normalized = charts.map((chart) => ({
      ...chart,
      symbol: marketDataSymbol(chart.symbol),
      comparison_symbol: chart.comparison_symbol === undefined
        ? undefined
        : marketDataSymbol(chart.comparison_symbol),
    }));
    const serialized = JSON.stringify(normalized);
    if (serialized === this.serializedCharts) return;
    this.charts = normalized;
    this.serializedCharts = serialized;
    this.requestId += 1;
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.sendDesiredCharts(this.socket);
    } else {
      this.connect();
    }
  }

  close() {
    this.closed = true;
    window.clearTimeout(this.reconnectTimer);
    this.socket?.close(1000, "chart closed");
    this.socket = undefined;
  }

  private connect() {
    if (
      this.closed
      || this.socket?.readyState === WebSocket.OPEN
      || this.socket?.readyState === WebSocket.CONNECTING
    ) return;
    window.clearTimeout(this.reconnectTimer);
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${window.location.host}/api/market-chart/live`);
    this.socket = socket;
    socket.addEventListener("open", () => {
      if (this.socket !== socket || this.closed) return;
      this.reconnectDelayMs = initialReconnectDelayMs;
      this.sendDesiredCharts(socket);
    });
    socket.addEventListener("message", (event) => {
      if (this.socket !== socket || this.closed) return;
      this.handleMessage(event.data);
    });
    socket.addEventListener("close", () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      if (!this.closed) this.scheduleReconnect();
    });
  }

  private sendDesiredCharts(socket: WebSocket) {
    socket.send(JSON.stringify({
      type: "set_charts",
      request_id: this.requestId,
      charts: this.charts,
    }));
  }

  private handleMessage(payload: unknown) {
    if (typeof payload !== "string") return;
    let event: LiveChartEvent;
    try {
      event = JSON.parse(payload) as LiveChartEvent;
    } catch {
      this.options.onError("Live chart sent invalid JSON");
      return;
    }
    if (event.request_id !== this.requestId) return;
    if (event.type === "error") {
      this.options.onError(event.message);
    } else if (event.type === "delta" && isLiveDelta(event.delta)) {
      this.options.onDelta(event.delta);
    } else if (event.type === "session" && isSessionDelta(event.delta)) {
      this.options.onSession(event.delta);
    }
  }

  private scheduleReconnect() {
    window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = window.setTimeout(() => this.connect(), this.reconnectDelayMs);
    this.reconnectDelayMs = Math.min(maximumReconnectDelayMs, this.reconnectDelayMs * 2);
  }
}

function isSessionDelta(delta: MarketChartSessionDelta): boolean {
  return typeof delta?.chart_id === "string"
    && typeof delta.symbol === "string"
    && (delta.session === "pre_market" || delta.session === "post_market")
    && Number.isFinite(delta.price)
    && (delta.session === "pre_market" ? isCandle(delta.candle) : delta.candle === null);
}

function isLiveDelta(delta: MarketChartLiveDelta): boolean {
  return typeof delta?.chart_id === "string"
    && typeof delta.symbol === "string"
    && (delta.interval === "daily" || delta.interval === "weekly")
    && isCandle(delta.candle)
    && Array.isArray(delta.moving_averages)
    && Array.isArray(delta.volume_average?.points);
}

function isCandle(candle: MarketChartCandle | null | undefined): candle is MarketChartCandle {
  return candle !== null
    && candle !== undefined
    && /^\d{4}-\d{2}-\d{2}$/.test(candle.date)
    && [candle.open, candle.high, candle.low, candle.close, candle.volume].every(Number.isFinite);
}
