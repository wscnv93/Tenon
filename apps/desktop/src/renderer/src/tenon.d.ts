import type { TenonEvent } from "@protocol/ipc";

declare global {
  interface Window {
    tenon: {
      invoke: (channel: string, payload?: unknown) => Promise<unknown>;
      onEvent: (callback: (event: TenonEvent) => void) => () => void;
      onTerminal: (
        callback: (payload: { id: string; data?: string; exited?: boolean; exitCode?: number }) => void,
      ) => () => void;
    };
  }
}

export {};
