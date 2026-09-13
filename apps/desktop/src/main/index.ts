import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensurePaths, getPaths } from "./paths.js";
import { loadSettings, makeProject, saveSettings, updateProject } from "./tenon-settings.js";
import { authStatus, removeCredential, setApiKey } from "./auth-store.js";
import { getPiVersion, hostManager, makeWindowSender, sendUserMessage } from "./pi-host.js";
import { listSessions } from "./sessions.js";
import * as git from "./git-service.js";
import { DEFAULT_MODE, ensureGateExtension, readModeFile, writeModeFile } from "./gate-extension.js";
import { TerminalService, TERMINAL_EVENT_CHANNEL } from "./terminal-service.js";
import { listProjectDir } from "./files-browse.js";
import { checkUpdate, downloadUpdate, installUpdate, type UpdateProgress } from "./update-service.js";
import type {
  TenonEvent,
  TenonInvokeChannel,
  TenonInvokeIn,
  TenonInvokeOut,
} from "@protocol/ipc";

// Product identity: fix the userData dir to "Tenon" (unversioned dev builds
// otherwise derive "@tenon/desktop" from the package name). Migrate legacy
// data from the old directory so existing projects/keys/sessions survive.
app.setName("Tenon");
{
  const legacy = join(app.getPath("appData"), "@tenon", "desktop");
  const target = join(app.getPath("appData"), "Tenon");
  if (!existsSync(target) && existsSync(legacy)) {
    try {
      renameSync(legacy, target);
    } catch {
      // Migration is best-effort; a fresh userData dir is acceptable.
    }
  }
  // Rewrite session paths recorded before the rename so "resume last session"
  // keeps working against the migrated store. Idempotent.
  try {
    const settingsFile = join(target, "tenon.json");
    if (existsSync(settingsFile)) {
      const raw = readFileSync(settingsFile, "utf-8");
      if (raw.includes("@tenon/desktop/sessions")) {
        writeFileSync(settingsFile, raw.split("@tenon/desktop/sessions").join("Tenon/sessions"));
      }
    }
  } catch {
    // Best effort.
  }
}

let mainWindow: BrowserWindow | null = null;
let terminalService: TerminalService;

// Per-project turn snapshots: captured before each prompt, resolved on settle.
const turnBefore = new Map<string, git.TurnSnapshot>();
const turnPaths = new Map<string, string[]>();

function sendUpdateProgress(
  stage: "idle" | "checking" | "downloading" | "installing" | "done" | "error",
  percent?: number,
  error?: string,
): void {
  send({ kind: "updateProgress", stage, percent, error });
}

function send(event: TenonEvent): void {
  const window = mainWindow;
  if (window && !window.isDestroyed()) {
    window.webContents.send("tenon:event", event);
  }
  // Resolve the "turn" review scope when the agent settles.
  if (event.kind === "agent" && event.event.type === "agent_settled") {
    git.invalidateGitCache(event.projectPath);
    const before = turnBefore.get(event.projectPath);
    if (before) {
      turnBefore.delete(event.projectPath);
      void git.captureSnapshot(event.projectPath).then((after) => {
        turnPaths.set(event.projectPath, git.diffSnapshots(before, after));
      }).catch(() => {});
    }
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
    icon: join(app.getAppPath(), "build", "icon.png"),
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
  // Surface renderer console output in the terminal (all in dev, warn+ in prod).
  mainWindow.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    const text = String(level);
    if (devUrl || text.includes("error") || text.includes("warning")) {
      console.log(`[renderer:${text}] ${message} (${sourceId}:${line})`);
    }
  });

  if (devUrl) {
    void mainWindow.loadURL(devUrl);
  } else {
    void mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

/**
 * Credential changes are not reliably picked up by a running pi process
 * (verified experimentally), so restart every running host after auth edits.
 * The handler only returns once restarts complete, which keeps the renderer's
 * follow-up getAvailableModels call deterministic.
 */
async function restartRunningHosts(): Promise<void> {
  const settings = loadSettings();
  for (const project of settings.projects) {
    const host = hostManager.get(project.path);
    if (!host?.running) continue;
    await host.stop();
    await hostManager.ensure(project.path, project.lastSessionPath);
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
  handle("auth:setApiKey", async ({ provider, key }) => {
    setApiKey(provider, key);
    await restartRunningHosts();
  });
  handle("auth:remove", async ({ provider }) => {
    removeCredential(provider);
    await restartRunningHosts();
  });

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
    try {
      turnBefore.set(projectPath, await git.captureSnapshot(projectPath));
    } catch {
      // Not a repo — the turn scope simply stays empty.
    }
    git.invalidateGitCache(projectPath);
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

  handle("agent:getTree", async ({ projectPath }) => {
    const host = await requireHost(projectPath);
    return host.rpc({ type: "get_tree" });
  });

  handle("agent:forkAt", async ({ projectPath, entryId }) => {
    const host = await requireHost(projectPath);
    await host.rpc({ type: "fork", entryId });
    const state = await host.refreshState();
    trackSession(projectPath, state.sessionFile);
    const messages = await host.rpc({ type: "get_messages" });
    return { state, messages: messages.messages };
  });

  handle("review:sendComments", async ({ projectPath, comments }) => {
    const host = await requireHost(projectPath);
    const body = comments.map((comment) => `- ${comment.path}:${comment.line} — ${comment.text}`).join("\n");
    await sendUserMessage(host, `请根据以下代码检视意见修改实现:\n${body}`);
    try {
      turnBefore.set(projectPath, await git.captureSnapshot(projectPath));
    } catch {
      // non-repo
    }
  });

  handle("agent:getExecMode", () => ({ mode: readModeFile() }));

  handle("agent:getEntries", async ({ projectPath }) => {
    const host = await requireHost(projectPath);
    return host.rpc({ type: "get_entries" });
  });

  handle("agent:setExecMode", ({ mode }) => {
    writeModeFile(mode);
  });

  handle("agent:extensionUiResponse", ({ projectPath, id, response }) => {
    const host = hostManager.get(projectPath);
    host?.rpcClientWrite({ type: "extension_ui_response", id, ...response });
  });

  handle("terminal:create", ({ projectPath, cols, rows }) => ({
    id: terminalService.create(projectPath, cols, rows),
  }));
  handle("terminal:input", ({ id, data }) => terminalService.input(id, data));
  handle("terminal:resize", ({ id, cols, rows }) => terminalService.resize(id, cols, rows));
  handle("terminal:dispose", ({ id }) => terminalService.dispose(id));
  handle("files:list", ({ projectPath, dir }) => ({ entries: listProjectDir(projectPath, dir) }));

  const DEFAULT_UPDATE_REPO = "wscnv93/Tenon";
  handle("settings:getUpdateRepo", () => ({ repo: loadSettings().updateRepo || DEFAULT_UPDATE_REPO }));
  handle("update:check", async ({ repo }) => {
    sendUpdateProgress("checking");
    return checkUpdate(repo || DEFAULT_UPDATE_REPO);
  });
  handle("settings:setUpdateRepo", ({ repo }) => {
    const settings = loadSettings();
    saveSettings({ ...settings, updateRepo: repo.trim() });
  });
  handle("update:check", async ({ repo }) => {
    sendUpdateProgress("checking");
    return checkUpdate(repo);
  });
  handle("update:install", async ({ repo }) => {
    try {
      sendUpdateProgress("checking");
      const check = await checkUpdate(repo || DEFAULT_UPDATE_REPO);
      if (check.error) {
        sendUpdateProgress("error", undefined, check.error);
        return;
      }
      if (!check.hasUpdate) {
        sendUpdateProgress("done");
        return;
      }
      if (!check.assetUrl) {
        sendUpdateProgress("error", undefined, "release 中没有匹配当前架构的 DMG");
        return;
      }
      const dmgPath = await downloadUpdate(check.assetUrl, (stage, percent, error) =>
        sendUpdateProgress(stage, percent, error),
      );
      sendUpdateProgress("installing");
      installUpdate(dmgPath);
      sendUpdateProgress("done");
      setTimeout(() => app.quit(), 1200);
    } catch (error) {
      sendUpdateProgress("error", undefined, error instanceof Error ? error.message : String(error));
    }
  });

  // ---------------------------------------------------------------- git
  handle("git:status", ({ projectPath }) => git.gitStatus(projectPath));

  handle("git:diff", async ({ projectPath, scope, view }) => {
    const result = await git.diffFiles(projectPath, scope, view, turnPaths.get(projectPath));
    return result;
  });

  const mutating = (fn: (projectPath: string) => Promise<void>): ((payload: { projectPath: string }) => Promise<void>) =>
    async ({ projectPath }) => {
      await fn(projectPath);
      git.invalidateGitCache(projectPath);
    };
  const fileOp = (fn: (projectPath: string, path: string) => Promise<void>) =>
    async ({ projectPath, path }: { projectPath: string; path: string }) => {
      await fn(projectPath, path);
      git.invalidateGitCache(projectPath);
    };
  const patchOp = (fn: (projectPath: string, path: string, patch: string) => Promise<void>) =>
    async ({ projectPath, path, patch }: { projectPath: string; path: string; patch: string }) => {
      await fn(projectPath, path, patch);
      git.invalidateGitCache(projectPath);
    };
  handle("git:stageFile", fileOp(git.stageFile));
  handle("git:unstageFile", fileOp(git.unstageFile));
  handle("git:discardFile", fileOp(git.discardFile));
  handle("git:stageHunk", patchOp(git.stageHunk));
  handle("git:unstageHunk", patchOp(git.unstageHunk));
  handle("git:discardHunk", patchOp(git.discardHunk));
  handle("git:stageAll", mutating(git.stageAll));
  handle("git:unstageAll", mutating(git.unstageAll));
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
    ensureGateExtension();
    terminalService = new TerminalService(() => mainWindow);
    // Brand icon for dev (packaged builds take the icon from build/icns).
    if (process.platform === "darwin" && app.dock) {
      const iconPath = join(app.getAppPath(), "build", "icon.png");
      if (existsSync(iconPath)) {
        app.dock.setIcon(iconPath);
      }
    }
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
    terminalService?.disposeAll();
  });
}
