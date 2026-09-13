import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { app, type BrowserWindow } from "electron";
import { VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";
import { PiRpcClient, type PiEvent } from "@protocol/rpc";
import type { RpcCommand, RpcSessionState } from "@protocol/pi-types";
import type { HostStatus, TenonEvent } from "@protocol/ipc";
import { getPaths } from "./paths.js";

/**
 * Manages one pi RPC child process per open project.
 *
 * Spawn strategy: run the bundled pi cli bundle with Electron's own binary in
 * Node mode (ELECTRON_RUN_AS_NODE=1). This works identically in development
 * and in packaged builds without requiring a system Node installation.
 *
 * NOTE for packaging: with ELECTRON_RUN_AS_NODE, asar archives are NOT
 * transparent — electron-builder must asarUnpack the pi package dist.
 */

export interface HostStartResult {
  state: RpcSessionState;
}

type Sender = (event: TenonEvent) => void;

interface PiRuntime {
  command: string;
  commandArgs: string[];
  /** Absent when `command` is the standalone pi binary. */
  cliPath?: string;
}

let cachedRuntime: PiRuntime | null = null;

/**
 * Resolution order:
 * 1. TENON_PI_BIN env (explicit override / system pi for debugging)
 * 2. vendored standalone binary (apps/desktop/vendor/pi-<platform>/pi) —
 *    a Bun-compiled single file; spawning it never touches LaunchServices,
 *    so no Dock registration/bounce from engine children
 * 3. fallback: the node_modules cli bundle run by Electron-as-Node (dev only)
 */
export function resolvePiRuntime(): PiRuntime {
  if (cachedRuntime) return cachedRuntime;
  const override = process.env.TENON_PI_BIN;
  if (override && existsSync(override)) {
    cachedRuntime = { command: override, commandArgs: [] };
    return cachedRuntime;
  }
  const vendorBinary = join(app.getAppPath(), "vendor", `pi-${process.platform}-${process.arch}`, "pi");
  if (existsSync(vendorBinary)) {
    cachedRuntime = { command: vendorBinary, commandArgs: [] };
    return cachedRuntime;
  }
  const entry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
  cachedRuntime = {
    command: process.execPath,
    commandArgs: [],
    cliPath: join(dirname(entry), "cli.js"),
  };
  return cachedRuntime;
}

export function getPiVersion(): string {
  return PI_VERSION;
}

export class PiHost {
  private client: PiRpcClient | null = null;
  private status: HostStatus = "stopped";
  private startPromise: Promise<PiHost> | null = null;
  private cachedState: RpcSessionState | null = null;
  /** Touched on every interaction; drives LRU eviction of background hosts. */
  lastUsedAt = Date.now();

  constructor(
    readonly projectPath: string,
    private readonly sender: Sender,
  ) {}

  get running(): boolean {
    return this.client !== null && this.status === "ready";
  }

  get state(): RpcSessionState | null {
    return this.cachedState;
  }

  private setStatus(status: HostStatus, error?: string): void {
    this.status = status;
    this.sender({ kind: "hostStatus", projectPath: this.projectPath, status, error });
  }

  async ensure(resumeSessionPath?: string): Promise<PiHost> {
    this.lastUsedAt = Date.now();
    if (this.client && this.status === "ready") {
      if (resumeSessionPath && this.cachedState?.sessionFile !== resumeSessionPath) {
        await this.rpc({ type: "switch_session", sessionPath: resumeSessionPath });
        this.cachedState = await this.rpc<RpcSessionState>({ type: "get_state" });
      }
      return this;
    }
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.start(resumeSessionPath);
    try {
      return await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  private async start(resumeSessionPath?: string): Promise<PiHost> {
    if (this.client) await this.stop();
    this.setStatus("starting");
    const paths = getPaths();
    const runtime = resolvePiRuntime();
    const client = new PiRpcClient({
      command: runtime.command,
      commandArgs: runtime.commandArgs,
      cliPath: runtime.cliPath,
      cwd: this.projectPath,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        PI_CODING_AGENT_DIR: paths.agentDir,
        PI_CODING_AGENT_SESSION_DIR: paths.sessionDir,
        // The desktop client manages updates; pi should never check for new
        // versions on its own.
        PI_SKIP_VERSION_CHECK: "1",
      },
    });
    this.client = client;
    client.on("event", (event: PiEvent) => {
      if (event.kind === "agent") {
        this.sender({ kind: "agent", projectPath: this.projectPath, event: event.event });
      } else {
        this.sender({ kind: "extensionUi", projectPath: this.projectPath, request: event.request });
      }
    });
    client.on("exit", (error: Error) => {
      if (this.status !== "stopped") {
        this.setStatus("error", error.message);
      }
      this.client = null;
    });
    client.on("parseError", (line: string) => {
      console.warn(`[tenon] unparsable pi stdout line: ${line.slice(0, 200)}`);
    });
    await client.start();
    if (resumeSessionPath) {
      await client.request({ type: "switch_session", sessionPath: resumeSessionPath });
    }
    this.cachedState = await client.request<RpcSessionState>({ type: "get_state" });
    this.setStatus("ready");
    return this;
  }

  async stop(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.setStatus("stopped");
    if (client) await client.stop();
  }

  async rpc<T = any>(command: RpcCommand, timeoutMs?: number): Promise<T> {
    this.lastUsedAt = Date.now();
    if (!this.client) throw new Error(`pi host for ${this.projectPath} is not running`);
    return this.client.request<T>(command, timeoutMs);
  }

  /** Fire-and-forget protocol write (extension_ui_response etc.). */
  rpcClientWrite(payload: unknown): void {
    if (!this.client) return;
    this.client.write(payload);
  }

  async refreshState(): Promise<RpcSessionState> {
    this.cachedState = await this.rpc<RpcSessionState>({ type: "get_state" });
    return this.cachedState;
  }
}

export class PiHostManager {
  private hosts = new Map<string, PiHost>();
  private sender: Sender = () => {};
  private activePath: string | null = null;
  private sweeper: NodeJS.Timeout | null = null;

  /** Idle background engines are stopped after this long. */
  private readonly idleEvictMs = Number(process.env.TENON_ENGINE_IDLE_MS ?? 180_000);
  /** At most this many engines stay warm (the active one is always kept). */
  private readonly maxEngines = Number(process.env.TENON_ENGINE_MAX ?? 3);
  private readonly sweepIntervalMs = 20_000;

  constructor() {
    // Recycle background engines so N projects never mean N resident processes.
    this.sweeper = setInterval(() => this.sweep(), this.sweepIntervalMs);
    this.sweeper.unref();
  }

  setSender(sender: Sender): void {
    this.sender = sender;
  }

  get(projectPath: string): PiHost | undefined {
    return this.hosts.get(projectPath);
  }

  /** Returns engines that are running right now. */
  listRunning(): PiHost[] {
    return [...this.hosts.values()].filter((host) => host.running);
  }

  private sweep(): void {
    const now = Date.now();
    const candidates = [...this.hosts.entries()]
      .filter(([path, host]) => host.running && path !== this.activePath)
      .filter(([, host]) => !(host.state?.isStreaming ?? false))
      .sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt);

    const reasons: string[] = [];
    for (const [path, host] of candidates) {
      const idleFor = now - host.lastUsedAt;
      const overCap = this.listRunning().length >= this.maxEngines;
      if (idleFor < this.idleEvictMs && !overCap) continue;
      reasons.push(`${path} (idle ${Math.round(idleFor / 1000)}s${overCap ? ", over cap" : ""})`);
      void host.stop().then(() => {
        if (this.hosts.get(path) === host) this.hosts.delete(path);
      });
    }
    if (reasons.length > 0) {
      console.log(`[tenon] recycled idle engines: ${reasons.join("; ")}`);
    }
  }

  async ensure(projectPath: string, resumeSessionPath?: string): Promise<PiHost> {
    this.activePath = projectPath;
    let host = this.hosts.get(projectPath);
    if (!host) {
      host = new PiHost(projectPath, this.sender);
      this.hosts.set(projectPath, host);
    }
    return host.ensure(resumeSessionPath);
  }

  async stopAll(): Promise<void> {
    if (this.sweeper) clearInterval(this.sweeper);
    await Promise.allSettled([...this.hosts.values()].map((host) => host.stop()));
    this.hosts.clear();
  }
}

export const hostManager = new PiHostManager();

/**
 * Route prompt/follow_up depending on current streaming state. pi requires
 * `streamingBehavior` only while streaming and rejects it otherwise, so we
 * branch on fresh state instead of trusting the renderer.
 */
export async function sendUserMessage(host: PiHost, message: string): Promise<void> {
  const state = await host.refreshState();
  if (state.isStreaming) {
    await host.rpc({ type: "follow_up", message });
  } else {
    await host.rpc({ type: "prompt", message });
  }
}

export function makeWindowSender(getWindow: () => Electron.BrowserWindow | null): Sender {
  return (event: TenonEvent) => {
    const window = getWindow();
    if (window && !window.isDestroyed()) {
      window.webContents.send("tenon:event", event);
    }
  };
}
