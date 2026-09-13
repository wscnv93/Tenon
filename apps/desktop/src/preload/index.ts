import { contextBridge, ipcRenderer } from "electron";
import type { TenonEvent } from "@protocol/ipc";

const api = {
  invoke: (channel: string, payload?: unknown): Promise<unknown> => ipcRenderer.invoke(channel, payload),
  onEvent: (callback: (event: TenonEvent) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, tenonEvent: TenonEvent): void => callback(tenonEvent);
    ipcRenderer.on("tenon:event", listener);
    return () => ipcRenderer.removeListener("tenon:event", listener);
  },
  onTerminal: (callback: (payload: { id: string; data?: string; exited?: boolean; exitCode?: number }) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown): void =>
      callback(payload as { id: string; data?: string; exited?: boolean; exitCode?: number });
    ipcRenderer.on("tenon:terminal", listener);
    return () => ipcRenderer.removeListener("tenon:terminal", listener);
  },
};

contextBridge.exposeInMainWorld("tenon", api);
