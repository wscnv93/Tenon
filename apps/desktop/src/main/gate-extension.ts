import { existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";
import { getPaths } from "./paths.js";
import type { ExecMode } from "@protocol/ipc";

/**
 * Distributes the tenon-gate extension into the Tenon-private agentDir and
 * manages the execution-mode file the extension reads on every tool call.
 *
 * Dev: agentDir/extensions/tenon-gate is a symlink to the workspace package
 * (its node_modules carry @anthropic-ai/sandbox-runtime). Prod: the package is
 * shipped via extraResources and linked the same way.
 */

export const EXEC_MODES: ExecMode[] = ["read-only", "workspace-write", "full"];
export const DEFAULT_MODE: ExecMode = "workspace-write";
export const MODE_FILE = "tenon-mode.json";

function extensionPackageSource(): string | null {
  // Dev: workspace package two levels up; packaged: extraResources copy.
  const candidates = [
    join(app.getAppPath(), "..", "..", "packages", "pi-extensions"),
    join(process.resourcesPath, "tenon-gate"),
    join(app.getAppPath(), "tenon-gate"),
  ];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "index.ts"))) return candidate;
  }
  return null;
}

export function ensureGateExtension(): void {
  const paths = getPaths();
  const extensionsDir = join(paths.agentDir, "extensions");
  mkdirSync(extensionsDir, { recursive: true });

  const source = extensionPackageSource();
  const link = join(extensionsDir, "tenon-gate");
  if (source && !existsSync(link) && !lstatSafe(link)) {
    try {
      symlinkSync(source, link, "dir");
    } catch {
      // Best effort: dev convenience only; packaged builds ship a real dir.
    }
  }

  const modeFile = join(paths.agentDir, MODE_FILE);
  if (!existsSync(modeFile)) {
    writeModeFile(DEFAULT_MODE);
  }
}

function lstatSafe(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

export function readModeFile(): ExecMode {
  try {
    const raw = JSON.parse(readFileSync(join(getPaths().agentDir, MODE_FILE), "utf-8")) as { mode?: string };
    return EXEC_MODES.includes(raw.mode as ExecMode) ? (raw.mode as ExecMode) : DEFAULT_MODE;
  } catch {
    return DEFAULT_MODE;
  }
}

export function writeModeFile(mode: ExecMode): void {
  writeFileSync(join(getPaths().agentDir, MODE_FILE), JSON.stringify({ mode }, null, 2));
}
