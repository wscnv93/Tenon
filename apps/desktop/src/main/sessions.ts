import { closeSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { getPaths } from "./paths.js";
import type { SessionSummary } from "@protocol/ipc";

/**
 * Lists recorded sessions for a project by scanning Tenon's private session
 * store. Performance contract: only the first 8KB of each file is ever read
 * (the session header lives on line 1), results are cached per file until
 * mtime/size change, and the scan is capped — this runs on the main process
 * and synchronous stalls here freeze every IPC round-trip.
 */
export function listSessions(projectPath: string): SessionSummary[] {
  const root = getPaths().sessionDir;
  const target = resolve(projectPath);
  const results: SessionSummary[] = [];
  const caseInsensitive = process.platform === "darwin" || process.platform === "win32";
  const matches = (candidate: string): boolean => {
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
  return results.slice(0, 200);
}

interface HeaderCacheEntry {
  mtime: number;
  size: number;
  cwd?: string;
  sessionId?: string;
}

const headerCache = new Map<string, HeaderCacheEntry>();

function inspectSessionFile(file: string): SessionSummary | null {
  let stats;
  try {
    stats = statSync(file);
  } catch {
    return null;
  }
  const cached = headerCache.get(file);
  if (cached && cached.mtime === stats.mtimeMs && cached.size === stats.size) {
    return { path: file, mtime: cached.mtime, size: cached.size, cwd: cached.cwd, sessionId: cached.sessionId };
  }

  let header: Record<string, unknown> | null = null;
  try {
    const fd = openSync(file, "r");
    try {
      const buffer = Buffer.alloc(8192);
      const bytesRead = readSync(fd, buffer, 0, 8192, 0);
      const firstLine = buffer.toString("utf-8", 0, bytesRead).split("\n")[0] ?? "";
      header = JSON.parse(firstLine) as Record<string, unknown>;
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }

  const name = basename(file, ".jsonl");
  const idPart = name.includes("_") ? name.slice(name.indexOf("_") + 1) : undefined;
  const entry: HeaderCacheEntry = {
    mtime: stats.mtimeMs,
    size: stats.size,
    cwd: typeof header?.cwd === "string" ? (header.cwd as string) : undefined,
    sessionId: idPart,
  };
  headerCache.set(file, entry);
  return { path: file, mtime: entry.mtime, size: entry.size, cwd: entry.cwd, sessionId: entry.sessionId };
}
