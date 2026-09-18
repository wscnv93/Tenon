/**
 * File-level dependency graph from the project's codegraph index
 * (colbymchenry/codegraph). Reads .codegraph/codegraph.db read-only via
 * node:sqlite — no daemon, no CLI spawn per view. Results cached per project
 * until the db file's mtime changes.
 *
 * Edge derivation (schema inspected empirically):
 * - edges.source/target reference node ids verbatim ("function:<hash>",
 *   "file:<path>"); nodes carry file_path.
 * - cross-file "calls"/"references"/"instantiates" edges aggregate to
 *   file→file with weights; "imports" edges whose source is a file node
 *   (target resolved to a node) add direct import links.
 */
import { createRequire } from "node:module";
import { statSync } from "node:fs";
import { join } from "node:path";
import type { FileGraph, FileGraphEdge, FileGraphNode } from "@protocol/ipc";

const CACHE_TTL_MS = 5000;
const cache = new Map<string, { at: number; mtime: number; graph: FileGraph }>();

// node:sqlite ships in Electron's bundled Node (22.5+); resolved through
// createRequire because the main bundle is ESM.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

export function fileGraph(projectPath: string): FileGraph {
  const dbPath = join(projectPath, ".codegraph", "codegraph.db");
  let mtime = 0;
  try {
    mtime = statSync(dbPath).mtimeMs;
  } catch {
    return { nodes: [], edges: [], indexed: false };
  }
  const cached = cache.get(projectPath);
  if (cached && cached.mtime === mtime && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.graph;
  }

  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const files = db
      .prepare("SELECT path, language, node_count FROM files WHERE generated = 0")
      .all() as Array<{ path: string; language: string; node_count: number }>;
    const byPath = new Map(files.map((file) => [file.path, file]));

    const nodeFile = new Map<string, string>();
    for (const row of db.prepare("SELECT id, file_path FROM nodes").all() as Array<{ id: string; file_path: string }>) {
      nodeFile.set(row.id, row.file_path);
    }

    const weights = new Map<string, FileGraphEdge>();
    const addEdge = (src: string, dst: string, kind: string): void => {
      if (src === dst || !byPath.has(src) || !byPath.has(dst)) return;
      const key = `${src}→${dst}`;
      const existing = weights.get(key);
      if (existing) {
        existing.weight += 1;
        if (!existing.kinds.includes(kind)) existing.kinds.push(kind);
      } else {
        weights.set(key, { src, dst, weight: 1, kinds: [kind] });
      }
    };

    for (const row of db
      .prepare("SELECT source, target, kind FROM edges WHERE kind IN ('calls','references','instantiates')")
      .all() as Array<{ source: string; target: string; kind: string }>) {
      const src = nodeFile.get(row.source);
      const dst = nodeFile.get(row.target);
      if (src && dst) addEdge(src, dst, row.kind);
    }
    for (const row of db
      .prepare("SELECT source, target FROM edges WHERE kind = 'imports' AND source LIKE 'file:%'")
      .all() as Array<{ source: string; target: string }>) {
      const src = row.source.slice("file:".length);
      const dst = nodeFile.get(row.target);
      if (dst) addEdge(src, dst, "imports");
    }

    const nodes: FileGraphNode[] = files.map((file) => ({
      path: file.path,
      language: file.language,
      nodeCount: file.node_count,
    }));
    const graph: FileGraph = { nodes, edges: [...weights.values()], indexed: true };
    cache.set(projectPath, { at: Date.now(), mtime, graph });
    return graph;
  } finally {
    db.close();
  }
}
