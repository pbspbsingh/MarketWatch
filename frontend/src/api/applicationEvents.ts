import type { IndustryCommand, IndustryEvent, IndustryResource, IndustryState } from "./generated/contracts";
import { queryClient } from "../shared/queryClient";

type Listener = (value: IndustryState | Error) => void;
type Subscription = { id: string; resource: IndustryResource; listeners: Set<Listener> };

export const industryQueryKey = (resource: IndustryResource) => ["industries", resource] as const;
const resourceKey = (resource: IndustryResource) => resource.type === "catalog"
  ? "catalog" : `membership:${resource.industry_key}`;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function validEvent(value: unknown): value is IndustryEvent {
  if (!record(value) || typeof value.subscription_id !== "string") return false;
  if (value.type === "error") return typeof value.message === "string";
  if (value.type !== "snapshot" || !record(value.state)) return false;
  const { data, fetched_at, expires_at, loading, error } = value.state;
  const timestamp = (item: unknown) => item === null || (typeof item === "string" && Number.isFinite(Date.parse(item)));
  if (!timestamp(fetched_at) || !timestamp(expires_at) || typeof loading !== "boolean"
    || !(error === null || typeof error === "string") || !record(data)) return false;
  if (data.type === "membership") return typeof data.industry_key === "string"
    && Array.isArray(data.symbols) && data.symbols.every(item => typeof item === "string");
  return data.type === "catalog" && Array.isArray(data.industries) && data.industries.every(item =>
    record(item) && ["industry_key", "industry_name", "sector_key", "sector_name"].every(key => typeof item[key] === "string")
      && typeof item.ticker_count === "number" && Number.isSafeInteger(item.ticker_count) && item.ticker_count >= 0);
}

export class ApplicationEvents {
  private running = false;
  private socket?: WebSocket;
  private timer?: number;
  private reconnectDelay = 1_000;
  private nextId = 0;
  private subscriptions = new Map<string, Subscription>();

  start() { this.running = true; this.connect(); }

  stop() {
    this.running = false;
    window.clearTimeout(this.timer);
    const socket = this.socket;
    this.socket = undefined;
    socket?.close(1000, "application closed");
  }

  observe(resource: IndustryResource, listener: Listener) {
    const key = resourceKey(resource);
    let subscription = this.subscriptions.get(key);
    if (!subscription) {
      subscription = { id: String(++this.nextId), resource, listeners: new Set() };
      this.subscriptions.set(key, subscription);
      this.send({ type: "subscribe", subscription_id: subscription.id, resource });
    }
    const owned = subscription;
    owned.listeners.add(listener);
    return () => {
      owned.listeners.delete(listener);
      if (owned.listeners.size || this.subscriptions.get(key) !== owned) return;
      this.subscriptions.delete(key);
      this.send({ type: "unsubscribe", subscription_id: owned.id });
    };
  }

  read(resource: IndustryResource, signal?: AbortSignal): Promise<IndustryState> {
    if (signal?.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
    return new Promise((resolve, reject) => {
      const finish = (value: IndustryState | Error) => {
        if (!(value instanceof Error) && value.loading) return;
        release();
        signal?.removeEventListener("abort", abort);
        if (value instanceof Error) reject(value);
        else if (value.fetched_at === null) reject(new Error(value.error ?? "Industry data unavailable"));
        else resolve(value);
      };
      const abort = () => finish(new DOMException("Aborted", "AbortError"));
      const existed = this.subscriptions.has(resourceKey(resource));
      const release = this.observe(resource, finish);
      signal?.addEventListener("abort", abort, { once: true });
      const subscription = this.subscriptions.get(resourceKey(resource))!;
      // Reading is the lazy freshness check. Replace the delivery identity so old
      // queued snapshots cannot satisfy a new request after a reconnect/selection.
      if (existed) {
        this.send({ type: "unsubscribe", subscription_id: subscription.id });
        subscription.id = String(++this.nextId);
        this.send({ type: "subscribe", subscription_id: subscription.id, resource });
      }
    });
  }

  private send(command: IndustryCommand) {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(command));
  }

  private connect() {
    if (!this.running || this.socket) return;
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${window.location.host}/api/events`);
    this.socket = socket;
    socket.addEventListener("open", () => {
      if (this.socket !== socket) return;
      this.reconnectDelay = 1_000;
      for (const { id, resource } of this.subscriptions.values()) {
        this.send({ type: "subscribe", subscription_id: id, resource });
      }
    });
    socket.addEventListener("message", (event) => {
      if (this.socket !== socket || typeof event.data !== "string") return;
      let value: unknown;
      try { value = JSON.parse(event.data); }
      catch { socket.close(1002, "invalid JSON"); return; }
      if (!validEvent(value)) { socket.close(1002, "invalid event"); return; }
      const subscription = [...this.subscriptions.values()].find(item => item.id === value.subscription_id);
      if (!subscription) return;
      if (value.type === "snapshot") {
        const expected = subscription.resource;
        const data = value.state.data;
        if (data.type !== expected.type || (data.type === "membership"
          && expected.type === "membership" && data.industry_key !== expected.industry_key)) {
          socket.close(1002, "unexpected resource");
          return;
        }
        queryClient.setQueryData(industryQueryKey(subscription.resource), value.state);
        for (const listener of [...subscription.listeners]) listener(value.state);
      } else if (value.type === "error") {
        for (const listener of [...subscription.listeners]) listener(new Error(value.message));
      } else socket.close(1002, "unknown event");
    });
    socket.addEventListener("close", () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      if (!this.running) return;
      this.timer = window.setTimeout(() => this.connect(), this.reconnectDelay);
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000);
    });
  }
}

export const applicationEvents = new ApplicationEvents();
