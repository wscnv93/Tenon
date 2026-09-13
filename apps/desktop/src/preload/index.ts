import { contextBridge, ipcRenderer } from "electron";
import type { TenonEvent } from "@protocol/ipc";

const api = {
  invoke: (channel: string, payload?: unknown): Promise<unknown> => ipcRenderer.invoke(channel, payload),
  onEvent: (callback: (event: TenonEvent) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, tenonEvent: TenonEvent): void => callback(tenonEvent);
    ipcRenderer.on("tenon:event", listener);
    return () => ipcRenderer.removeListener("tenon:event", listener);
  },
};

contextBridge.exposeInMainWorld("tenon", api);
