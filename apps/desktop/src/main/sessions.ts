import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { getPaths } from "./paths.js";
import type { SessionSummary } from "@protocol/ipc";

/**
 * Lists recorded sessions for a project by scanning Tenon's private session
 * store. pi writes one JSONL per session whose first line is the session
 * header (contains `cwd`); we match on that instead of trusting the
 * path-flattened directory naming so the scan survives pi renaming schemes.
 */
export function listSessions(projectPath: string): SessionSummary[] {
  const root = getPaths().sessionDir;
  const target = resolve(projectPath);
  const results: SessionSummary[] = [];
  const caseInsensitive = process.platform === "darwin" || process.platform === "win32";
  const matches = (candidate: string) => {
    const resolved = resolve(candidate);
    return caseInsensitive ? resolved.toLowerCase() === target.toLowerCase() : resolved === target;
  };

  const walk = (dir: string, depth: number): void => {
    if (depth > 4) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        const summary = inspectSessionFile(full);
        if (summary && summary.cwd && matches(summary.cwd)) {
          results.push(summary);
        }
      }
    }
  };

  walk(root, 0);
  results.sort((a, b) => b.mtime - a.mtime);
  return results;
}

function inspectSessionFile(file: string): SessionSummary | null {
  try {
    const stats = statSync(file);
    let header: Record<string, unknown> | null = null;
    const stream = readFileSync(file, { encoding: "utf-8", flag: "r" });
    const firstLine = stream.slice(0, stream.indexOf("\n") === -1 ? undefined : stream.indexOf("\n"));
    try {
      header = JSON.parse(firstLine) as Record<string, unknown>;
    } catch {
      header = null;
    }
    const name = basename(file, ".jsonl");
    const idPart = name.includes("_") ? name.slice(name.indexOf("_") + 1) : undefined;
    return {
      path: file,
      sessionId: idPart,
      cwd: typeof header?.cwd === "string" ? (header.cwd as string) : undefined,
      mtime: stats.mtimeMs,
      size: stats.size,
    };
  } catch {
    return null;
  }
}
