export interface LivePriceUpdate {
  symbol: string;
  price: number;
  updatedAt: string;
}

interface LivePriceClientOptions {
  onAvailability: (available: boolean, marketDate: string) => void;
  onPrice: (update: LivePriceUpdate) => void;
  onError: (message: string) => void;
}

type LivePriceEvent =
  | { type: "availability"; available: boolean; market_date: string }
  | { type: "subscribed"; request_id: number; symbols: string[] }
  | {
      type: "price";
      request_id: number;
      symbol: string;
      price: number;
      updated_at: string;
    }
  | { type: "error"; request_id: number; message: string };

const initialReconnectDelayMs = 1_000;
const maximumReconnectDelayMs = 30_000;

export class LivePriceClient {
  private socket?: WebSocket;
  private reconnectTimer?: number;
  private reconnectDelayMs = initialReconnectDelayMs;
  private requestId = 0;
  private symbols: string[] = [];
  private closed = false;

  constructor(private readonly options: LivePriceClientOptions) {}

  start() {
    this.connect();
  }

  setSymbols(symbols: string[]) {
    const normalized = [...new Set(symbols.map((symbol) => symbol.trim().toUpperCase()))].sort();
    if (JSON.stringify(normalized) === JSON.stringify(this.symbols)) return;
    this.symbols = normalized;
    this.requestId += 1;
    if (this.socket?.readyState === WebSocket.OPEN) this.sendSymbols(this.socket);
    else this.connect();
  }

  close() {
    this.closed = true;
    window.clearTimeout(this.reconnectTimer);
    this.socket?.close(1000, "live prices closed");
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
    const socket = new WebSocket(`${protocol}//${window.location.host}/api/live-prices`);
    this.socket = socket;
    socket.addEventListener("open", () => {
      if (this.socket !== socket || this.closed) return;
      this.reconnectDelayMs = initialReconnectDelayMs;
      this.sendSymbols(socket);
    });
    socket.addEventListener("message", (event) => {
      if (this.socket === socket && !this.closed) this.handleMessage(event.data);
    });
    socket.addEventListener("close", () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      if (!this.closed) this.scheduleReconnect();
    });
  }

  private sendSymbols(socket: WebSocket) {
    socket.send(JSON.stringify({
      type: "set_symbols",
      request_id: this.requestId,
      symbols: this.symbols,
    }));
  }

  private handleMessage(payload: unknown) {
    if (typeof payload !== "string") return;
    let event: LivePriceEvent;
    try {
      event = JSON.parse(payload) as LivePriceEvent;
    } catch {
      this.options.onError("Live prices sent invalid JSON");
      return;
    }
    if (event === null || typeof event !== "object" || !("type" in event)) {
      this.options.onError("Live prices sent an invalid event");
      return;
    }
    if (event.type === "availability" && isAvailabilityEvent(event)) {
      this.options.onAvailability(event.available, event.market_date);
    } else if ("request_id" in event && event.request_id !== this.requestId) {
      return;
    } else if (event.type === "price" && isPriceEvent(event)) {
      this.options.onPrice({
        symbol: event.symbol,
        price: event.price,
        updatedAt: event.updated_at,
      });
    } else if (event.type === "error" && typeof event.message === "string") {
      this.options.onError(event.message);
    }
  }

  private scheduleReconnect() {
    window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = window.setTimeout(() => this.connect(), this.reconnectDelayMs);
    this.reconnectDelayMs = Math.min(maximumReconnectDelayMs, this.reconnectDelayMs * 2);
  }
}

function isAvailabilityEvent(event: Extract<LivePriceEvent, { type: "availability" }>) {
  return typeof event.available === "boolean" && isMarketDate(event.market_date);
}

function isPriceEvent(event: Extract<LivePriceEvent, { type: "price" }>) {
  return typeof event.symbol === "string"
    && Number.isFinite(event.price)
    && event.price > 0
    && !Number.isNaN(Date.parse(event.updated_at));
}

function isMarketDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}
