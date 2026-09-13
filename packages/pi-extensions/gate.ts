/**
 * Tenon gate — execution modes, sandboxing, and approvals inside the pi process.
 *
 * Loaded automatically from <agentDir>/extensions/. Modes are stored by the
 * Tenon main process in <agentDir>/tenon-mode.json and re-read on every tool
 * call, so switching modes never requires an engine restart.
 *
 * Modes:
 * - read-only: bash runs in a Seatbelt/bubblewrap sandbox with write access to
 *   temp only and no network; edit/write tools are blocked. Escalation to an
 *   unsandboxed run requires explicit user approval.
 * - workspace-write: bash is sandboxed with write access to the project and
 *   temp, no network. Commands that look like they need network or write
 *   outside the workspace trigger an approval dialog first.
 * - full: no sandbox, no prompts.
 *
 * Approvals surface through pi's extension UI protocol; in Tenon the desktop
 * client renders them as approval cards.
 */
import { homedir, tmpdir } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type ExecMode = "read-only" | "workspace-write" | "full";

const MODE_FILE = "tenon-mode.json";

const APPROVAL_OPTIONS = ["允许一次", "本会话内允许", "拒绝"] as const;

/** Commands that typically need network access. */
const NETWORK_PATTERNS: Array<[RegExp, string]> = [
  [/\b(curl|wget|fetch)\b/, "网络下载"],
  [/\b(npm|pnpm|yarn|bun)\s+(i|install|add|publish|update)\b/, "包管理器安装"],
  [/\bpip3?\s+install\b/, "pip 安装"],
  [/\bgit\s+(push|pull|fetch|clone)\b/, "git 远程操作"],
  [/\b(ssh|scp|rsync)\b/, "远程连接"],
  [/\bbrew\s+install\b/, "Homebrew 安装"],
  [/\bcargo\s+(publish|install)\b/, "cargo 安装"],
];

/** Absolute paths outside the workspace the command tries to write. */
function writesOutsideWorkspace(command: string, cwd: string): boolean {
  const absolute = command.match(/(?:^|[\s(=])(\/(?:Users|home|Volumes|etc|usr\/local|opt)\/[^\s'"|;&>]*)/g);
  if (!absolute) return false;
  for (const raw of absolute) {
    const path = raw.trim();
    if (path.startsWith("/tmp") || path.startsWith("/private/tmp")) continue;
    if (path.startsWith("/usr/local/bin") || path.startsWith("/opt/homebrew/bin")) continue; // binaries on PATH
    const resolved = resolve(path);
    if (!resolved.startsWith(resolve(cwd))) return true;
  }
  return false;
}

function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

function readMode(): ExecMode {
  try {
    const file = join(agentDir(), MODE_FILE);
    if (!existsSync(file)) return "workspace-write";
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as { mode?: string };
    if (parsed.mode === "read-only" || parsed.mode === "workspace-write" || parsed.mode === "full") {
      return parsed.mode;
    }
    return "workspace-write";
  } catch {
    return "workspace-write";
  }
}

interface GateState {
  initializedKey: string | null;
  sessionAllowed: Set<string>;
  tmp: string;
}

const state: GateState = {
  initializedKey: null,
  sessionAllowed: new Set(),
  tmp: tmpdir(),
};

async function ensureSandbox(mode: ExecMode, cwd: string): Promise<void> {
  const key = `${mode}:${cwd}`;
  if (state.initializedKey === key) return;
  if (state.initializedKey !== null) {
    try {
      await SandboxManager.reset();
    } catch {
      // Reset failures are non-fatal; re-initialize regardless.
    }
  }
  await SandboxManager.initialize({
    network: { allowedDomains: [], deniedDomains: [] },
    filesystem: {
      denyRead: ["~/.ssh", "~/.aws", "~/.gnupg"],
      allowWrite: mode === "read-only" ? [state.tmp, "/tmp", "/private/tmp"] : [cwd, state.tmp, "/tmp", "/private/tmp"],
      denyWrite: [".env", ".env.*", "*.pem", "*.key"],
    },
  });
  state.initializedKey = key;
}

interface ApprovalDecision {
  escalated: boolean;
}

interface UiLike {
  hasUI: boolean;
  ui: { select: (title: string, options: string[]) => Promise<string | undefined> };
}

async function requestEscalation(
  ctx: UiLike,
  kind: string,
  detail: string,
  ruleKey: string,
): Promise<ApprovalDecision> {
  if (state.sessionAllowed.has(ruleKey)) return { escalated: true };
  if (!ctx.hasUI) return { escalated: false };
  const choice = await ctx.ui.select(
    `Tenon 沙箱请求批准\n\n${kind}:${detail}\n\n此命令需要超出当前沙箱限制的权限,允许吗?`,
    [...APPROVAL_OPTIONS],
  );
  if (choice === "本会话内允许") {
    state.sessionAllowed.add(ruleKey);
    return { escalated: true };
  }
  if (choice === "允许一次") return { escalated: true };
  return { escalated: false };
}

export function setupGate(pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    const mode = readMode();
    const cwd = ctx.cwd;

    if ((event.toolName === "edit" || event.toolName === "write") && mode === "read-only") {
      return {
        block: true,
        reason: "当前执行模式为「只读」,不允许修改文件。请切换到「确认改动」或「完全访问」后再试。",
      };
    }

    if (event.toolName !== "bash") return undefined;
    if (mode === "full") return undefined;

    const command = String((event.input as { command?: string }).command ?? "");
    if (!command.trim()) return undefined;

    // Heuristic escalation checks — these run the command unsandboxed on approval.
    const networkHit = NETWORK_PATTERNS.find(([pattern]) => pattern.test(command));
    const outsideWrite = writesOutsideWorkspace(command, cwd);
    if (networkHit || outsideWrite) {
      const kind = networkHit ? networkHit[1] : "写入工作区之外的路径";
      const decision = await requestEscalation(ctx, kind, command.slice(0, 200), `${kind}:${command.slice(0, 80)}`);
      if (!decision.escalated) {
        return { block: true, reason: `用户拒绝了${kind}的请求。` };
      }
      return undefined; // unsandboxed run
    }

    // Otherwise wrap in the OS sandbox for this mode.
    try {
      await ensureSandbox(mode, cwd);
      const wrapped = await SandboxManager.wrapWithSandbox(command);
      (event.input as { command: string }).command = wrapped;
    } catch (err) {
      // Sandbox unavailable — fail closed with a clear reason the model can act on.
      return {
        block: true,
        reason: `沙箱初始化失败(${err instanceof Error ? err.message : String(err)}),已阻止执行。可在 Tenon 中切换执行模式后重试。`,
      };
    }
    return undefined;
  });

  pi.on("session_start", async (_event, ctx) => {
    state.sessionAllowed.clear();
    state.initializedKey = null;
    const mode = readMode();
    ctx.ui.notify(`Tenon 执行模式:${mode === "read-only" ? "只读" : mode === "workspace-write" ? "确认改动(沙箱)" : "完全访问"}`, "info");
  });
}
