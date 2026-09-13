import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { join } from "node:path";
import { ensurePaths, getPaths } from "./paths.js";
import { loadSettings, makeProject, saveSettings, updateProject } from "./tenon-settings.js";
import { authStatus, removeCredential, setApiKey } from "./auth-store.js";
import { getPiVersion, hostManager, makeWindowSender, sendUserMessage } from "./pi-host.js";
import { listSessions } from "./sessions.js";
import type {
  TenonEvent,
  TenonInvokeChannel,
  TenonInvokeIn,
  TenonInvokeOut,
} from "@protocol/ipc";

let mainWindow: BrowserWindow | null = null;

function send(event: TenonEvent): void {
  const window = mainWindow;
  if (window && !window.isDestroyed()) {
    window.webContents.send("tenon:event", event);
  }
}

function emitSettingsChanged(): void {
  const settings = loadSettings();
  send({ kind: "settingsChanged", projects: settings.projects, activeProjectId: settings.activeProjectId });
}

function handle<C extends TenonInvokeChannel>(
  channel: C,
  handler: (payload: TenonInvokeIn<C>) => Promise<TenonInvokeOut<C>> | TenonInvokeOut<C>,
): void {
  ipcMain.handle(channel, (_event, payload: TenonInvokeIn<C>) => handler(payload));
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1080,
    minHeight: 640,
    backgroundColor: "#0d0f12",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    trafficLightPosition: { x: 16, y: 16 },
    show: false,
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.on("ready-to-show", () => mainWindow?.show());
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) {
    void mainWindow.loadURL(devUrl);
  } else {
    void mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

function registerIpc(): void {
  handle("app:info", () => {
    const paths = getPaths();
    return {
      appVersion: app.getVersion(),
      userDataDir: paths.userDataDir,
      agentDir: paths.agentDir,
      sessionDir: paths.sessionDir,
      piVersion: getPiVersion(),
      platform: process.platform,
    };
  });

  handle("projects:list", () => {
    const settings = loadSettings();
    return { projects: settings.projects, activeProjectId: settings.activeProjectId };
  });

  handle("projects:add", async () => {
    const result = await dialog.showOpenDialog(mainWindow!, { properties: ["openDirectory", "createDirectory"] });
    if (result.canceled || result.filePaths.length === 0) {
      throw new Error("No folder selected");
    }
    const dir = result.filePaths[0]!;
    const settings = loadSettings();
    const existing = settings.projects.find((project) => project.path === dir);
    if (existing) {
      saveSettings({ ...settings, activeProjectId: existing.id });
      emitSettingsChanged();
      return existing;
    }
    const project = makeProject(dir);
    saveSettings({ projects: [...settings.projects, project], activeProjectId: project.id });
    emitSettingsChanged();
    return project;
  });

  handle("projects:remove", ({ id }) => {
    const settings = loadSettings();
    const projects = settings.projects.filter((project) => project.id !== id);
    const activeProjectId =
      settings.activeProjectId === id ? (projects[0]?.id ?? null) : settings.activeProjectId;
    saveSettings({ projects, activeProjectId });
    emitSettingsChanged();
    return { projects, activeProjectId };
  });

  handle("projects:setActive", ({ id }) => {
    const settings = loadSettings();
    if (!settings.projects.some((project) => project.id === id)) {
      throw new Error(`Unknown project: ${id}`);
    }
    saveSettings({ ...settings, activeProjectId: id });
    emitSettingsChanged();
  });

  handle("auth:status", () => authStatus());
  handle("auth:setApiKey", ({ provider, key }) => setApiKey(provider, key));
  handle("auth:remove", ({ provider }) => removeCredential(provider));

  const requireHost = async (projectPath: string) => hostManager.ensure(projectPath);

  handle("agent:start", async ({ projectPath }) => {
    const host = await requireHost(projectPath);
    const state = await host.refreshState();
    const messages = await host.rpc({ type: "get_messages" });
    return { state, messages: messages.messages };
  });

  handle("agent:ensure", async ({ projectPath, resumeSessionPath }) => {
    const host = await hostManager.ensure(projectPath, resumeSessionPath);
    const state = await host.refreshState();
    const messages = await host.rpc({ type: "get_messages" });
    return { state, messages: messages.messages };
  });

  handle("agent:stop", async ({ projectPath }) => {
    await hostManager.get(projectPath)?.stop();
  });

  handle("agent:prompt", async ({ projectPath, message }) => {
    const host = await requireHost(projectPath);
    await sendUserMessage(host, message);
    const state = await host.refreshState();
    trackSession(projectPath, state.sessionFile);
  });

  handle("agent:steer", async ({ projectPath, message }) => {
    const host = await requireHost(projectPath);
    await host.rpc({ type: "steer", message });
  });

  handle("agent:abort", async ({ projectPath }) => {
    const host = await requireHost(projectPath);
    await host.rpc({ type: "abort" });
  });

  handle("agent:getState", async ({ projectPath }) => {
    const host = await requireHost(projectPath);
    return host.refreshState();
  });

  handle("agent:getMessages", async ({ projectPath }) => {
    const host = await requireHost(projectPath);
    return host.rpc({ type: "get_messages" });
  });

  handle("agent:getAvailableModels", async ({ projectPath }) => {
    const host = await requireHost(projectPath);
    return host.rpc({ type: "get_available_models" }, 180_000);
  });

  handle("agent:setModel", async ({ projectPath, provider, modelId }) => {
    const host = await requireHost(projectPath);
    await host.rpc({ type: "set_model", provider, modelId });
    const state = await host.refreshState();
    return { state };
  });

  handle("agent:setThinkingLevel", async ({ projectPath, level }) => {
    const host = await requireHost(projectPath);
    await host.rpc({ type: "set_thinking_level", level });
  });

  handle("agent:getThinkingLevels", async ({ projectPath }) => {
    const host = await requireHost(projectPath);
    return host.rpc({ type: "get_available_thinking_levels" });
  });

  handle("agent:newSession", async ({ projectPath, name }) => {
    const host = await requireHost(projectPath);
    await host.rpc({ type: "new_session" });
    if (name) {
      await host.rpc({ type: "set_session_name", name });
    }
    const state = await host.refreshState();
    trackSession(projectPath, state.sessionFile);
    return { state };
  });

  handle("agent:switchSession", async ({ projectPath, sessionPath }) => {
    const host = await hostManager.ensure(projectPath, sessionPath);
    const state = await host.refreshState();
    trackSession(projectPath, state.sessionFile);
    const messages = await host.rpc({ type: "get_messages" });
    return { state, messages: messages.messages };
  });

  handle("agent:setSessionName", async ({ projectPath, name }) => {
    const host = await requireHost(projectPath);
    await host.rpc({ type: "set_session_name", name });
  });

  handle("sessions:list", ({ projectPath }) => ({ sessions: listSessions(projectPath) }));
}

function trackSession(projectPath: string, sessionFile: string | undefined): void {
  if (!sessionFile) return;
  const settings = loadSettings();
  const project = settings.projects.find((entry) => entry.path === projectPath);
  if (project && project.lastSessionPath !== sessionFile) {
    updateProject(project.id, { lastSessionPath: sessionFile });
  }
}

// Single instance: focus the existing window instead of spawning a second app.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  void app.whenReady().then(() => {
    ensurePaths();
    hostManager.setSender(makeWindowSender(() => mainWindow));
    registerIpc();
    createWindow();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", () => {
    // Best-effort; child processes also die with SIGTERM propagation.
    void hostManager.stopAll();
  });
}
