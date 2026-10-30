import { createStore } from "zustand/vanilla";
import { marketDataSymbol } from "./marketChart";
import type { LiveCommand, LiveEvent, RawLiveChartRequest } from "./generated/contracts";
import { isLiveDelta, isSessionDelta, type MarketChartLiveDelta, type MarketChartSessionDelta } from "./marketChartLive";
import { isVolumeRunRateState, mergeVolumeRunRateState, type VolumeRunRateState } from "./volumeRunRate";

export interface LivePriceUpdate {
  symbol: string;
  price: number;
  updatedAt: string;
}
export type LiveChartResource = Omit<RawLiveChartRequest, "chart_id">;
export interface LiveChartState {
  delta?: MarketChartLiveDelta;
  session?: MarketChartSessionDelta;
  volumeRunRate?: VolumeRunRateState;
  error?: string;
}
interface LiveState {
  status: "disconnected" | "connecting" | "connected" | "reconnecting";
  charts: Record<string, LiveChartState>;
  availability?: { available: boolean; marketDate: string };
  prices: Map<string, LivePriceUpdate>;
  error?: string;
}
interface ChartSubscription {
  id: string;
  resource: LiveChartResource;
  consumers: number;
}
export const emptyLiveChart: LiveChartState = {};

export function liveChartResource(resource: LiveChartResource): LiveChartResource {
  const comparison = resource.comparison_symbol == null ? null : marketDataSymbol(resource.comparison_symbol);
  return {
    symbol: marketDataSymbol(resource.symbol), interval: resource.interval,
    comparison_symbol: comparison,
    relative_strength_period: comparison === null ? null : resource.relative_strength_period ?? (resource.interval === "weekly" ? 2 : 5),
    volume_run_rate: resource.volume_run_rate,
  };
}
export function liveChartKey(resource: LiveChartResource) {
  return JSON.stringify(liveChartResource(resource));
}

// One application-owned transport. Components acquire resources, never sockets.
export class GlobalLivePrices {
  readonly store = createStore<LiveState>(() => ({ status: "disconnected", charts: {}, prices: new Map() }));
  private socket?: WebSocket;
  private reconnectTimer?: number;
  private flushTimer?: number;
  private retryDelay = 1_000;
  private started = false;
  private requestId = 0;
  private nextId = 0;
  private charts = new Map<string, ChartSubscription>();
  private priceConsumers = new Map<object, string[]>();
  private pendingPrices = new Map<string, LivePriceUpdate>();

  start() {
    if (this.started) return;
    this.started = true;
    this.connect();
  }
  stop() {
    this.started = false;
    window.clearTimeout(this.reconnectTimer);
    window.clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    this.pendingPrices.clear();
    const socket = this.socket;
    this.socket = undefined;
    socket?.close(1000, "application stopped");
    this.store.setState({ status: "disconnected", charts: {}, prices: new Map(), availability: undefined, error: undefined });
  }
  observeChart(raw: LiveChartResource) {
    const resource = liveChartResource(raw);
    const key = liveChartKey(resource);
    let subscription = this.charts.get(key);
    if (subscription === undefined) {
      subscription = { id: `chart-${++this.nextId}`, resource, consumers: 0 };
      this.charts.set(key, subscription);
    }
    subscription.consumers++;
    if (subscription.consumers === 1) this.changed();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--subscription.consumers !== 0) return;
      this.charts.delete(key);
      this.store.setState(state => {
        const charts = { ...state.charts };
        delete charts[key];
        return { charts };
      });
      this.changed();
    };
  }
  observePrices(symbols: string[]) {
    const token = {};
    this.priceConsumers.set(token, [...new Set(symbols.map(marketDataSymbol))]);
    this.changed();
    return () => {
      if (this.priceConsumers.delete(token)) this.changed();
    };
  }
  private desiredSymbols() {
    return [...new Set([...this.priceConsumers.values()].flat())].sort();
  }
  private changed() {
    this.requestId++;
    const desired = new Set(this.desiredSymbols());
    this.pendingPrices.forEach((_, symbol) => { if (!desired.has(symbol)) this.pendingPrices.delete(symbol); });
    this.store.setState(state => ({ prices: new Map([...state.prices].filter(([symbol]) => desired.has(symbol))) }));
    if (this.socket?.readyState === WebSocket.OPEN) this.send(this.socket);
  }
  private send(socket: WebSocket) {
    const command: LiveCommand = {
      type: "set_subscriptions", request_id: this.requestId,
      charts: [...this.charts.values()].map(({ id, resource }) => ({ ...resource, chart_id: id })),
      symbols: this.desiredSymbols(),
    };
    socket.send(JSON.stringify(command));
  }
  private connect() {
    if (!this.started || this.socket !== undefined) return;
    this.store.setState({ status: this.retryDelay === 1_000 ? "connecting" : "reconnecting" });
    let socket: WebSocket;
    try {
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(`${protocol}//${window.location.host}/api/live-prices`);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.addEventListener("open", () => {
      if (this.socket !== socket || !this.started) return;
      this.retryDelay = 1_000;
      this.store.setState({ status: "connected", error: undefined });
      this.send(socket);
    });
    socket.addEventListener("message", event => {
      if (this.socket !== socket || !this.started) return;
      try { this.receive(event.data); }
      catch {
        this.store.setState({ error: "Live prices sent an invalid event" });
        socket.close(1002, "invalid live event");
      }
    });
    socket.addEventListener("close", () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      window.clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
      this.pendingPrices.clear();
      this.store.setState({ charts: {}, prices: new Map(), availability: undefined });
      if (this.started) this.scheduleReconnect();
    });
  }
  private scheduleReconnect() {
    this.store.setState({ status: "reconnecting" });
    window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = window.setTimeout(() => this.connect(), this.retryDelay);
    this.retryDelay = Math.min(30_000, this.retryDelay * 2);
  }
  private receive(payload: unknown) {
    let event: LiveEvent;
    try {
      if (typeof payload !== "string") throw new Error();
      event = JSON.parse(payload) as LiveEvent;
      if (event === null || typeof event !== "object" || typeof event.type !== "string") throw new Error();
    } catch {
      this.store.setState({ error: "Live prices sent an invalid event" });
      this.socket?.close(1002, "invalid live event");
      return;
    }
    if (event.type === "availability") {
      if (typeof event.available !== "boolean" || !/^\d{4}-\d{2}-\d{2}$/.test(event.market_date)) return;
      this.store.setState(state => ({
        availability: { available: event.available, marketDate: event.market_date },
        prices: state.availability?.marketDate === event.market_date && event.available ? state.prices : new Map(),
      }));
      this.pendingPrices.clear();
      return;
    }
    if (event.request_id !== this.requestId) return;
    if (event.type === "error") {
      if (typeof event.message !== "string") return;
      if (event.chart_id !== null) {
        const entry = [...this.charts.entries()].find(([, chart]) => chart.id === event.chart_id);
        if (entry !== undefined) this.store.setState(state => ({ charts: {
          ...state.charts, [entry[0]]: { ...state.charts[entry[0]], error: event.message },
        } }));
      } else this.store.setState({ error: event.message });
      return;
    }
    if (event.type === "subscribed") {
      this.store.setState({ error: undefined });
      return;
    }
    if (event.type === "price") {
      if (!this.store.getState().availability?.available || !this.desiredSymbols().includes(event.symbol) || !Number.isFinite(event.price) || event.price <= 0
        || typeof event.updated_at !== "string" || !Number.isFinite(Date.parse(event.updated_at))) return;
      this.pendingPrices.set(event.symbol, { symbol: event.symbol, price: event.price, updatedAt: event.updated_at });
      this.flushTimer ??= window.setTimeout(() => {
        this.flushTimer = undefined;
        const prices = this.pendingPrices;
        this.pendingPrices = new Map();
        this.store.setState(state => ({ prices: new Map([...state.prices, ...prices]) }));
      }, 250);
      return;
    }
    if (event.type !== "volume_run_rate" && event.type !== "delta" && event.type !== "session") return;
    const id = event.type === "volume_run_rate" ? event.chart_id : event.delta?.chart_id;
    const entry = [...this.charts.entries()].find(([, chart]) => chart.id === id);
    if (entry === undefined) return;
    const [key, { resource }] = entry;
    this.store.setState(state => {
      const current = state.charts[key] ?? emptyLiveChart;
      let next: LiveChartState;
      if (event.type === "delta" && isLiveDelta(event.delta) && event.delta.symbol === resource.symbol && event.delta.interval === resource.interval) {
        const relative = event.delta.relative_strength;
        if (relative !== null && (relative.comparison_symbol !== resource.comparison_symbol
          || relative.line.moving_average_period !== resource.relative_strength_period)) return state;
        next = { ...current, delta: event.delta, session: sessionAfterRegularUpdate(current.session, event.delta), error: undefined };
      } else if (event.type === "session" && resource.interval === "daily" && isSessionDelta(event.delta) && event.delta.symbol === resource.symbol) {
        next = { ...current, session: event.delta, error: undefined };
      } else if (event.type === "volume_run_rate" && resource.volume_run_rate && isVolumeRunRateState(event.state) && event.state.symbol === resource.symbol) {
        next = { ...current, volumeRunRate: mergeVolumeRunRateState(current.volumeRunRate, event.state) };
      } else return state;
      return { charts: { ...state.charts, [key]: next } };
    });
  }
}
export function sessionAfterRegularUpdate(current: MarketChartSessionDelta | undefined, regular: MarketChartLiveDelta) {
  if (regular.interval !== "daily") return current;
  if (current?.symbol !== regular.symbol) return undefined;
  if (current.session === "pre_market" && current.date > regular.candle.date) return current;
  return current.session === "post_market" && current.date === regular.candle.date ? current : undefined;
}
export const livePrices = new GlobalLivePrices();
