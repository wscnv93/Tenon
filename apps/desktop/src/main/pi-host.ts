import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
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
  cliPath: string;
}

let cachedRuntime: PiRuntime | null = null;

export function resolvePiRuntime(): PiRuntime {
  if (cachedRuntime) return cachedRuntime;
  // pi's package.json exports map has no "require" condition, so
  // createRequire().resolve() fails; ESM resolution is the only route.
  const entry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
  const cliPath = join(dirname(entry), "cli.js");
  cachedRuntime = {
    command: process.execPath,
    commandArgs: [],
    cliPath,
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
    if (!this.client) throw new Error(`pi host for ${this.projectPath} is not running`);
    return this.client.request<T>(command, timeoutMs);
  }

  async refreshState(): Promise<RpcSessionState> {
    this.cachedState = await this.rpc<RpcSessionState>({ type: "get_state" });
    return this.cachedState;
  }
}

export class PiHostManager {
  private hosts = new Map<string, PiHost>();
  private sender: Sender = () => {};

  setSender(sender: Sender): void {
    this.sender = sender;
  }

  get(projectPath: string): PiHost | undefined {
    return this.hosts.get(projectPath);
  }

  async ensure(projectPath: string, resumeSessionPath?: string): Promise<PiHost> {
    let host = this.hosts.get(projectPath);
    if (!host) {
      host = new PiHost(projectPath, this.sender);
      this.hosts.set(projectPath, host);
    }
    return host.ensure(resumeSessionPath);
  }

  async stopAll(): Promise<void> {
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
