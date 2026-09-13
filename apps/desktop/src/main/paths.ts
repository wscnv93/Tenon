import { app } from "electron";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Tenon keeps all pi engine state under its own userData tree so the app is
 * fully self-contained (no dependency on ~/.pi) and uninstalling Tenon removes
 * everything. pi honors these via PI_CODING_AGENT_DIR / PI_CODING_AGENT_SESSION_DIR.
 */
export interface TenonPaths {
  userDataDir: string;
  agentDir: string;
  sessionDir: string;
  settingsFile: string;
}

let cached: TenonPaths | null = null;

export function getPaths(): TenonPaths {
  if (cached) return cached;
  const userDataDir = app.getPath("userData");
  cached = {
    userDataDir,
    agentDir: join(userDataDir, "agent"),
    sessionDir: join(userDataDir, "sessions"),
    settingsFile: join(userDataDir, "tenon.json"),
  };
  return cached;
}

export function ensurePaths(): TenonPaths {
  const paths = getPaths();
  mkdirSync(paths.agentDir, { recursive: true });
  mkdirSync(paths.sessionDir, { recursive: true });
  return paths;
}
