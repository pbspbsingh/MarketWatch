import type { TickerRanking } from "./tickers";

export interface TickerStreamClient {
  streamSymbols(
    symbols: string[],
    onTicker: (ticker: TickerRanking) => void,
    signal?: AbortSignal,
  ): Promise<void>;
  close(): void;
}

export function createTickerStreamClient(): TickerStreamClient {
  return new WebSocketTickerStreamClient();
}

type TickerStreamEvent =
  | { request_id: number; type: "ticker"; ticker: TickerRanking }
  | { request_id: number; type: "complete" }
  | { request_id: number; type: "error"; message: string };

const idleSocketTimeoutMs = 30_000;

class WebSocketTickerStreamClient implements TickerStreamClient {
  private socket?: WebSocket;
  private open?: Promise<WebSocket>;
  private requestId = 0;
  private active?: {
    id: number;
    onTicker: (ticker: TickerRanking) => void;
    resolve: () => void;
    reject: (error: unknown) => void;
    signal?: AbortSignal;
    abort: () => void;
  };
  private idleTimer?: number;

  streamSymbols(symbols: string[], onTicker: (ticker: TickerRanking) => void, signal?: AbortSignal) {
    this.clearIdleTimer();
    this.abortActive();
    const id = ++this.requestId;
    return new Promise<void>((resolve, reject) => {
      const abort = () => {
        if (this.socket?.readyState === WebSocket.OPEN) {
          this.socket.send(JSON.stringify({ type: "cancel", request_id: id }));
        }
        this.finish(id, () => reject(new DOMException("Aborted", "AbortError")));
        this.scheduleIdleClose();
      };
      this.active = { id, onTicker, resolve, reject, signal, abort };
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) {
        abort();
        return;
      }
      this.ensureSocket()
        .then((socket) => {
          if (this.active?.id !== id) return;
          socket.send(JSON.stringify({
            type: "stream",
            request_id: id,
            group_type: "symbols",
            symbols,
          }));
        })
        .catch((error: unknown) => this.finish(id, () => reject(error)));
    });
  }

  close() {
    this.abortActive();
    this.clearIdleTimer();
    const socket = this.socket;
    this.socket = undefined;
    this.open = undefined;
    socket?.close(1000, "ticker lens unmounted");
  }

  private ensureSocket() {
    if (this.socket?.readyState === WebSocket.OPEN) return Promise.resolve(this.socket);
    if (this.socket?.readyState === WebSocket.CONNECTING && this.open !== undefined) return this.open;
    this.socket = undefined;
    this.open = undefined;
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${window.location.host}/api/tickers`);
    this.socket = socket;
    this.open = new Promise<WebSocket>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(socket), { once: true });
      socket.addEventListener("error", () => reject(new Error("Ticker WebSocket failed")), { once: true });
    });
    socket.addEventListener("message", (message) => this.handleMessage(message));
    socket.addEventListener("close", () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.open = undefined;
      const active = this.active;
      if (active !== undefined) this.finish(active.id, () => active.reject(new Error("Ticker WebSocket closed")));
    });
    return this.open;
  }

  private handleMessage(message: MessageEvent) {
    let event: TickerStreamEvent;
    try {
      event = JSON.parse(String(message.data)) as TickerStreamEvent;
    } catch {
      this.failProtocol("Ticker WebSocket sent invalid JSON");
      return;
    }
    if (event.request_id !== this.active?.id) return;
    if (event.type === "ticker") this.active.onTicker(event.ticker);
    else if (event.type === "error") {
      this.finish(event.request_id, () => this.active?.reject(new Error(event.message)));
      this.scheduleIdleClose();
    }
    if (event.type === "complete") {
      this.finish(event.request_id, () => this.active?.resolve());
      this.scheduleIdleClose();
    } else if (event.type !== "ticker" && event.type !== "error") {
      this.failProtocol("Ticker WebSocket sent an unknown event");
    }
  }

  private finish(id: number, action: () => void) {
    if (this.active?.id !== id) return;
    this.active.signal?.removeEventListener("abort", this.active.abort);
    action();
    this.active = undefined;
  }

  private abortActive() {
    const active = this.active;
    active?.abort();
  }

  private clearIdleTimer() {
    if (this.idleTimer !== undefined) window.clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  private scheduleIdleClose() {
    this.clearIdleTimer();
    this.idleTimer = window.setTimeout(() => {
      const socket = this.socket;
      this.socket = undefined;
      this.open = undefined;
      socket?.close(1000, "ticker stream idle");
    }, idleSocketTimeoutMs);
  }

  private failProtocol(message: string) {
    const active = this.active;
    if (active !== undefined) this.finish(active.id, () => active.reject(new Error(message)));
    const socket = this.socket;
    this.socket = undefined;
    this.open = undefined;
    socket?.close(1002, "protocol error");
  }
}
