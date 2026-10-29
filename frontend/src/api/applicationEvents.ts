import type { ApplicationCommand, ApplicationResource, ApplicationSnapshot } from "./generated/contracts";
import { isApplicationEvent, snapshotMatchesResource } from "./applicationEventProtocol";
import { applicationConnection, createApplicationConnectionStore } from "../shared/applicationConnection";

type Listener = (value: ApplicationSnapshot | Error) => void;
type Subscription = { id: string; resource: ApplicationResource; listeners: Set<Listener> };

const resourceKey = (resource: ApplicationResource) => JSON.stringify(resource, (_key, value: unknown) =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)))
    : value);

export class ApplicationEvents {
  private running = false;
  private socket?: WebSocket;
  private timer?: number;
  private reconnectDelay = 1_000;
  private nextId = 0;
  private subscriptions = new Map<string, Subscription>();

  constructor(private readonly connection = createApplicationConnectionStore()) {}

  start() {
    if (this.running) return;
    this.running = true;
    this.connect();
  }

  stop() {
    this.running = false;
    window.clearTimeout(this.timer);
    this.timer = undefined;
    this.reconnectDelay = 1_000;
    const socket = this.socket;
    this.socket = undefined;
    socket?.close(1000, "application closed");
    this.connection.setState({ status: "disconnected", retryAttempt: 0 });
  }

  observe(resource: ApplicationResource, listener: Listener, { resubscribe = false }: { resubscribe?: boolean } = {}) {
    const key = resourceKey(resource);
    let subscription = this.subscriptions.get(key);
    if (!subscription) {
      subscription = { id: String(++this.nextId), resource, listeners: new Set() };
      this.subscriptions.set(key, subscription);
      this.send({ type: "subscribe", subscription_id: subscription.id, resource });
    } else if (resubscribe) {
      this.send({ type: "unsubscribe", subscription_id: subscription.id });
      subscription.id = String(++this.nextId);
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

  private send(command: ApplicationCommand) {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(command));
  }

  private connect() {
    if (!this.running || this.socket) return;
    this.connection.setState({ status: this.connection.getState().retryAttempt ? "reconnecting" : "connecting" });
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    let socket: WebSocket;
    try { socket = new WebSocket(`${protocol}//${window.location.host}/api/events`); }
    catch { this.scheduleReconnect(); return; }
    this.socket = socket;
    socket.addEventListener("open", () => {
      if (this.socket !== socket) return;
      this.reconnectDelay = 1_000;
      this.connection.setState({ status: "connected", retryAttempt: 0 });
      for (const { id, resource } of this.subscriptions.values()) {
        this.send({ type: "subscribe", subscription_id: id, resource });
      }
    });
    socket.addEventListener("message", (event) => {
      if (this.socket !== socket || typeof event.data !== "string") return;
      let value: unknown;
      try { value = JSON.parse(event.data); }
      catch { socket.close(1002, "invalid JSON"); return; }
      if (!isApplicationEvent(value)) { socket.close(1002, "invalid event"); return; }
      const subscription = [...this.subscriptions.values()].find(item => item.id === value.subscription_id);
      if (!subscription) return;
      if (value.type === "snapshot") {
        if (!snapshotMatchesResource(subscription.resource, value.payload)) {
          socket.close(1002, "unexpected resource");
          return;
        }
        this.deliver(subscription, value.payload);
      } else if (value.type === "error") {
        this.deliver(subscription, new Error(value.message));
      } else socket.close(1002, "unknown event");
    });
    socket.addEventListener("close", () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.scheduleReconnect();
    });
  }

  private deliver(subscription: Subscription, value: ApplicationSnapshot | Error) {
    for (const listener of [...subscription.listeners]) {
      try { listener(value); }
      catch (error) { console.error("Application event listener failed", error); }
    }
  }

  private scheduleReconnect() {
    if (!this.running) return;
    this.connection.setState(state => ({ status: "reconnecting", retryAttempt: state.retryAttempt + 1 }));
    this.timer = window.setTimeout(() => this.connect(), this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000);
  }
}

export const applicationEvents = new ApplicationEvents(applicationConnection);
