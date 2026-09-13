import { readdirSync } from "node:fs";
import { join } from "node:path";

/** Directories that are never interesting to browse. */
const IGNORED = new Set([
  "node_modules", ".git", "dist", "out", "build", "coverage", ".next", ".turbo",
  ".venv", "venv", "__pycache__", "target", ".cache", "release",
]);

/**
 * Lists one directory of the project for the files pane's non-repo fallback
 * browser. Lazy per-directory: the caller expands level by level, so no
 * full-tree scan ever blocks.
 */
export function listProjectDir(projectPath: string, dir?: string): Array<{ name: string; isDir: boolean }> {
  const base = dir ? join(projectPath, dir) : projectPath;
  let entries;
  try {
    entries = readdirSync(base, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => !entry.name.startsWith(".") || entry.name === ".env.example")
    .filter((entry) => !IGNORED.has(entry.name))
    .map((entry) => ({ name: entry.name, isDir: entry.isDirectory() }))
    .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
}
