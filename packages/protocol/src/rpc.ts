/**
 * Tenon's pi RPC client.
 *
 * Implements the same wire protocol as pi's official `RpcClient`
 * (JSONL over stdio; see pi's docs/rpc.md and dist/modes/rpc/rpc-types.d.ts)
 * but owns the spawn strategy so it works both in development (node_modules)
 * and in packaged builds (bundled runtime + cli bundle / sidecar binary).
 *
 * Framing notes (protocol-critical):
 * - Strict LF-only JSONL. Node's readline is NOT protocol-compliant because it
 *   also splits on U+2028/U+2029, which are valid inside JSON strings.
 * - Commands are flat objects: `{ id?, type, ...params }`.
 * - Responses: `{ type: "response", command, success, error?, data?, id? }`.
 *   Failure responses have `success: false` and a top-level `error` string.
 * - Everything else on stdout is a `JsonAgentSessionEvent` or an
 *   `RpcExtensionUIRequest`.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import type {
  JsonAgentSessionEvent,
  RpcCommand,
  RpcExtensionUIRequest,
  RpcResponse,
} from "./pi-types.js";

export interface PiSpawnOptions {
  /** Executable that runs the pi cli bundle (node, bun, electron-with-ELECTRON_RUN_AS_NODE...). */
  command: string;
  /** Extra args inserted before the cli bundle path (e.g. ["run-node"]). */
  commandArgs?: string[];
  /** Absolute path of the pi cli entry (`dist/cli.js`). */
  cliPath: string;
  /** Project working directory for the agent. */
  cwd: string;
  env?: Record<string, string | undefined>;
  provider?: string;
  model?: string;
  sessionDir?: string;
  extraArgs?: string[];
}

export type PiEvent = { kind: "agent"; event: JsonAgentSessionEvent } | { kind: "extensionUi"; request: RpcExtensionUIRequest };

interface Pending {
  command: string;
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

/** Split a UTF-16 chunk stream into strict LF-only lines. */
class LfLineBuffer {
  private buffer = "";
  constructor(private readonly onLine: (line: string) => void) {}
  push(chunk: string): void {
    this.buffer += chunk;
    let index = this.buffer.indexOf("\n");
    while (index >= 0) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (line.endsWith("\r")) this.onLine(line.slice(0, -1));
      else this.onLine(line);
      index = this.buffer.indexOf("\n");
    }
  }
  flush(): void {
    if (this.buffer.length > 0) {
      this.onLine(this.buffer);
      this.buffer = "";
    }
  }
}

export class PiRpcClient extends EventEmitter {
  private process: ChildProcess | null = null;
  private pending = new Map<string, Pending>();
  private nextId = 1;
  private stdoutBuffer: LfLineBuffer;
  private stderrText = "";
  private exitError: Error | null = null;
  private stopped = false;

  constructor(private readonly options: PiSpawnOptions) {
    super();
    this.stdoutBuffer = new LfLineBuffer((line) => this.handleLine(line));
  }

  get stderr(): string {
    return this.stderrText;
  }

  async start(): Promise<void> {
    if (this.process) throw new Error("pi rpc process already started");
    const args = [
      ...(this.options.commandArgs ?? []),
      this.options.cliPath,
      "--mode",
      "rpc",
      ...(this.options.provider ? ["--provider", this.options.provider] : []),
      ...(this.options.model ? ["--model", this.options.model] : []),
      ...(this.options.sessionDir ? ["--session-dir", this.options.sessionDir] : []),
      ...(this.options.extraArgs ?? []),
    ];
    const child = spawn(this.options.command, args, {
      cwd: this.options.cwd,
      env: this.options.env as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.process = child;

    child.stdout?.setEncoding("utf-8");
    child.stdout?.on("data", (chunk: string) => this.stdoutBuffer.push(chunk));
    child.stdout?.on("end", () => this.stdoutBuffer.flush());
    child.stderr?.setEncoding("utf-8");
    child.stderr?.on("data", (chunk: string) => {
      this.stderrText += chunk;
    });
    child.once("error", (error) => this.failAll(new Error(`pi process error: ${error.message}`)));
    child.once("exit", (code, signal) => {
      this.exitError =
        this.exitError ??
        new Error(`pi process exited (code=${code} signal=${signal})${this.stderrText ? `\nstderr:\n${this.stderrText.slice(-4000)}` : ""}`);
      this.failAll(this.exitError);
      this.emit("exit", this.exitError);
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const child = this.process;
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      this.failAll(new Error("pi process stopped"));
      return;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
      }, 3000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      child.stdin?.end();
      child.kill("SIGTERM");
    });
  }

  /** Send a command and resolve with its `data` payload (or undefined). */
  request<T = any>(command: RpcCommand, timeoutMs = 120_000): Promise<T> {
    const child = this.process;
    if (!child || this.exitError) {
      throw this.exitError ?? new Error("pi process not started");
    }
    const id = String(this.nextId++);
    const payload = { id, ...command } as RpcCommand;
    return new Promise<T>((resolve, reject) => {
      const pending: Pending = {
        command: command.type,
        resolve,
        reject,
        timer: timeoutMs > 0 ? setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`pi rpc command "${command.type}" timed out after ${timeoutMs}ms`));
        }, timeoutMs) : undefined,
      };
      this.pending.set(id, pending);
      child.stdin?.write(JSON.stringify(payload) + "\n", (error) => {
        if (error) {
          this.pending.delete(id);
          if (pending.timer) clearTimeout(pending.timer);
          reject(new Error(`failed to write pi rpc command: ${error.message}`));
        }
      });
    });
  }

  /** Fire-and-forget write (used for extension_ui_response which carries its own id). */
  write(payload: unknown): void {
    const child = this.process;
    if (!child) throw new Error("pi process not started");
    child.stdin?.write(JSON.stringify(payload) + "\n");
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    let message: any;
    try {
      message = JSON.parse(trimmed);
    } catch {
      this.emit("parseError", trimmed);
      return;
    }
    if (message?.type === "response") {
      this.handleResponse(message as RpcResponse);
    } else if (message?.type === "extension_ui_request") {
      this.emit("event", { kind: "extensionUi", request: message } satisfies PiEvent);
    } else if (typeof message?.type === "string") {
      this.emit("event", { kind: "agent", event: message as JsonAgentSessionEvent } satisfies PiEvent);
    }
  }

  private handleResponse(response: RpcResponse): void {
    const id = response.id;
    if (id === undefined) return;
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    if (pending.timer) clearTimeout(pending.timer);
    if (response.success) {
      pending.resolve((response as any).data);
    } else {
      pending.reject(new Error(`pi rpc "${response.command}" failed: ${response.error}`));
    }
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    if (!this.stopped) this.exitError = this.exitError ?? error;
  }
}
