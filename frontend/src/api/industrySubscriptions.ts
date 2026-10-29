import { ApplicationEvents, applicationEvents } from "./applicationEvents";
import type { IndustryResource, IndustryState } from "./generated/contracts";
import { queryClient } from "../shared/queryClient";

type Listener = (value: IndustryState | Error) => void;
export const industryQueryKey = (resource: IndustryResource) => ["industries", resource] as const;

export class IndustrySubscriptions {
  constructor(private readonly events: ApplicationEvents) {}

  observe(resource: IndustryResource, listener: Listener, resubscribe = false) {
    return this.events.observe({ domain: "industry", resource }, (payload) => {
      if (payload instanceof Error) { listener(payload); return; }
      if (payload.domain !== "industry") { listener(new Error("Unexpected subscription domain")); return; }
      const state = payload.state;
      queryClient.setQueryData(industryQueryKey(resource), state);
      listener(state);
    }, { resubscribe });
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
      // A read rechecks lazy freshness through a new delivery identity. Queued
      // responses from the previous subscription cannot satisfy this request.
      const release = this.observe(resource, finish, true);
      signal?.addEventListener("abort", abort, { once: true });
    });
  }
}

export const industrySubscriptions = new IndustrySubscriptions(applicationEvents);
