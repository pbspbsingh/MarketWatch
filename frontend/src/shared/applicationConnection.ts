import { createStore } from "zustand/vanilla";

export type ApplicationConnectionState = {
  status: "disconnected" | "connecting" | "connected" | "reconnecting";
  retryAttempt: number;
};

export const createApplicationConnectionStore = () => createStore<ApplicationConnectionState>(() => ({
  status: "disconnected",
  retryAttempt: 0,
}));

export const applicationConnection = createApplicationConnectionStore();
