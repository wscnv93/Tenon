/**
 * Code index: tree-sitter WASM parsing → symbols + call sites, incremental
 * via fs.watch, persisted as JSON next to the engine config.
 *
 * Deliberately dependency-light: symbols resolve by name within the project
 * (no type analysis) — the same pragmatic trade-off the MIT CodeGraphContext
 * makes, sized for an in-engine process where the agent loop must stay snappy.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { join, relative, sep } from "node:path";
import ParserCjs from "web-tree-sitter";
import { EXT_TO_LANG, LANGUAGES, type LanguageDef } from "./languages.js";

const Parser = ParserCjs as unknown as {
  init: () => Promise<void>;
  Language: { load: (bytes: Uint8Array) => Promise<any> };
  new (): any;
};

interface IndexedSymbol {
  name: string;
  kind: string;
  /** 1-based start line. */
  line: number;
  endLine: number;
  container?: string;
}

interface IndexedCall {
  callee: string;
  line: number;
  enclosing?: string;
}

interface FileEntry {
  mtime: number;
  symbols: IndexedSymbol[];
  calls: IndexedCall[];
}

const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "out", "build", "coverage", ".next", ".turbo",
  ".venv", "venv", "__pycache__", "target", "vendor", ".cache", "release",
]);
const SKIP_DIR_LIST = [...SKIP_DIRS];
const MAX_FILE_BYTES = 1_000_000;
const MAX_FILES = 20_000;

export type ProgressFn = (indexed: number, total: number) => void;

export class CodeIndex {
  private parser: any | null = null;
  private languages = new Map<string, any>();
  private loading: Promise<void> | null = null;
  private files = new Map<string, FileEntry>();
  private byName = new Map<string, Array<{ file: string; symbol: IndexedSymbol }>>();
  private watcher: FSWatcher | null = null;
  private debounce: NodeJS.Timeout | null = null;
  private pending = new Set<string>();

  constructor(
    private readonly projectPath: string,
    private readonly storePath: string,
    private readonly onProgress: ProgressFn = () => {},
  ) {}

  // ---------------------------------------------------------------- lifecycle

  async initialize(): Promise<{ files: number; symbols: number; reused: boolean }> {
    if (!this.loading) {
      this.loading = (async () => {
        await Parser.init();
        this.parser = new Parser();
      })();
    }
    await this.loading;

    let reused = false;
    if (existsSync(this.storePath)) {
      try {
        const saved = JSON.parse(readFileSync(this.storePath, "utf-8")) as {
          root: string;
          files: Record<string, FileEntry>;
        };
        if (saved.root === this.projectPath) {
          for (const [file, entry] of Object.entries(saved.files)) {
            const abs = join(this.projectPath, file);
            if (!existsSync(abs)) continue;
            const mtime = statSync(abs).mtimeMs;
            if (Math.abs(mtime - entry.mtime) < 2) {
              this.files.set(abs, entry);
            }
          }
          reused = this.files.size > 0;
        }
      } catch {
        // Corrupt index — start fresh.
      }
    }

    const scan = this.collectFiles();
    // Preload grammars for the languages actually present before any parsing.
    const needed = new Set<string>();
    for (const file of scan) {
      const id = EXT_TO_LANG[file.slice(file.lastIndexOf("."))];
      if (id) needed.add(id);
    }
    for (const id of needed) await this.langFor(id);

    const stale = scan.filter((file) => !this.files.has(file));
    let done = 0;
    for (const file of stale) {
      this.indexFile(file);
      done++;
      if (done % 50 === 0) {
        this.onProgress(done, stale.length);
        await new Promise((resolve) => setImmediate(resolve));
      }
    }
    this.onProgress(done, stale.length);
    this.rebuildNameMap();
    this.persist();

    this.startWatcher();
    return { files: this.files.size, symbols: [...this.byName.keys()].length, reused };
  }

  dispose(): void {
    this.watcher?.close();
    if (this.debounce) clearTimeout(this.debounce);
  }

  get stats(): { files: number; symbols: number } {
    return { files: this.files.size, symbols: this.byName.size };
  }

  // ------------------------------------------------------------------ queries

  lookupSymbol(name: string): Array<{ file: string; symbol: IndexedSymbol }> {
    return this.byName.get(name) ?? [];
  }

  searchSymbols(query: string, limit = 30): Array<{ file: string; symbol: IndexedSymbol }> {
    const q = query.toLowerCase();
    const results: Array<{ file: string; symbol: IndexedSymbol }> = [];
    for (const [name, refs] of this.byName) {
      if (results.length >= limit) break;
      if (name.toLowerCase().includes(q)) {
        for (const ref of refs) {
          results.push(ref);
          if (results.length >= limit) break;
        }
      }
    }
    return results;
  }

  callersOf(name: string, limit = 40): Array<{ file: string; caller?: string; line: number }> {
    const results: Array<{ file: string; caller?: string; line: number }> = [];
    for (const [file, entry] of this.files) {
      for (const call of entry.calls) {
        if (call.callee === name) {
          results.push({ file, caller: call.enclosing, line: call.line });
          if (results.length >= limit) return results;
        }
      }
    }
    return results;
  }

  calleesOf(name: string, limit = 40): Array<{ callee: string; file: string; line: number }> {
    if (!this.byName.has(name)) return [];
    const results: Array<{ callee: string; file: string; line: number }> = [];
    for (const [file, entry] of this.files) {
      for (const call of entry.calls) {
        if (call.enclosing === name) {
          results.push({ callee: call.callee, file, line: call.line });
          if (results.length >= limit) return results;
        }
      }
    }
    return results;
  }

  fileSymbols(file: string): IndexedSymbol[] {
    const rel = relative(this.projectPath, file);
    for (const [key, entry] of this.files) {
      if (key.endsWith(file) || key.endsWith(rel)) return entry.symbols;
    }
    return [];
  }

  // ------------------------------------------------------------------ parsing

  private async langFor(languageId: string): Promise<any | null> {
    const cached = this.languages.get(languageId);
    if (cached) return cached;
    const def = LANGUAGES[languageId];
    if (!def) return null;
    const wasmPath = join(
      dirname2(new URL(import.meta.url).pathname),
      "..",
      "node_modules",
      "tree-sitter-wasms",
      "out",
      def.wasm,
    );
    if (!existsSync(wasmPath)) return null;
    try {
      const language = await Parser.Language.load(new Uint8Array(readFileSync(wasmPath)));
      this.languages.set(languageId, language);
      return language;
    } catch {
      return null;
    }
  }

  private indexFile(absPath: string): boolean {
    const ext = absPath.slice(absPath.lastIndexOf("."));
    const languageId = EXT_TO_LANG[ext];
    if (!languageId) return false;
    let source: string;
    try {
      const stats = statSync(absPath);
      if (stats.size > MAX_FILE_BYTES) return false;
      source = readFileSync(absPath, "utf-8");
    } catch {
      return false;
    }
    // Ignore binary-looking files.
    if (source.includes("\u0000")) return false;

    const def = LANGUAGES[languageId];
    if (!def) return false;
    const symbols: IndexedSymbol[] = [];
    const calls: IndexedCall[] = [];

    // Synchronous inline: parser reuse per language, queries per file.
    // (The async language loader is resolved before the scan loop starts.)
    const language = this.languages.get(languageId);
    if (!language) return false;
    this.parser!.setLanguage(language);
    const tree = this.parser!.parse(source);

    for (const [kind, querySrc] of def.symbols) {
      let query;
      try {
        query = language.query(querySrc);
      } catch {
        continue;
      }
      for (const match of query.matches(tree.rootNode)) {
        const nameCap = match.captures.find((c: any) => c.name === "name");
        const defnCap = match.captures.find((c: any) => c.name === "defn");
        if (!nameCap || !defnCap) continue;
        const node = defnCap.node;
        const line = node.startPosition.row + 1;
        if (symbols.some((s) => s.name === nameCap.node.text && s.line === line)) continue;
        symbols.push({
          name: nameCap.node.text,
          kind,
          line,
          endLine: node.endPosition.row + 1,
          container: enclosingOf(symbols, line),
        });
      }
      query.delete();
    }

    for (const querySrc of def.calls) {
      let query;
      try {
        query = language.query(querySrc);
      } catch {
        continue;
      }
      for (const match of query.matches(tree.rootNode)) {
        const calleeCap = match.captures.find((c: any) => c.name === "callee" || c.name === "member");
        if (!calleeCap) continue;
        const line = calleeCap.node.startPosition.row + 1;
        calls.push({ callee: calleeCap.node.text, line, enclosing: enclosingOf(symbols, line) });
      }
      query.delete();
    }

    tree.delete?.();
    this.files.set(absPath, { mtime: statSync(absPath).mtimeMs, symbols, calls });
    return true;
  }

  // -------------------------------------------------------------------- watch

  private startWatcher(): void {
    if (this.watcher) return;
    try {
      this.watcher = watch(this.projectPath, { recursive: true }, (_event, filename) => {
        if (!filename) return;
        const abs = join(this.projectPath, filename.toString());
        const ext = abs.slice(abs.lastIndexOf("."));
        if (!EXT_TO_LANG[ext]) return;
        if (SKIP_DIR_LIST.some((dir) => abs.includes(`${sep}${dir}${sep}`))) return;
        this.pending.add(abs);
        if (this.debounce) clearTimeout(this.debounce);
        this.debounce = setTimeout(() => {
          const changed = [...this.pending];
          this.pending.clear();
          let dirty = false;
          for (const file of changed) {
            if (!existsSync(file)) {
              if (this.files.delete(file)) dirty = true;
              continue;
            }
            if (this.indexFile(file)) dirty = true;
          }
          if (dirty) {
            this.rebuildNameMap();
            this.persist();
          }
        }, 600);
      });
    } catch {
      // Watch unavailable — index stays static; tool results note staleness.
    }
  }

  private collectFiles(): string[] {
    const out: string[] = [];
    const walk = (dir: string, depth: number): void => {
      if (depth > 12 || out.length >= MAX_FILES) return;
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name.startsWith(".") && entry.name !== ".") {
          if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
        }
        if (entry.isDirectory()) {
          if (SKIP_DIRS.has(entry.name)) continue;
          walk(join(dir, entry.name), depth + 1);
        } else if (EXT_TO_LANG[entry.name.slice(entry.name.lastIndexOf("."))]) {
          out.push(join(dir, entry.name));
          if (out.length >= MAX_FILES) return;
        }
      }
    };
    walk(this.projectPath, 0);
    return out;
  }

  private rebuildNameMap(): void {
    this.byName = new Map();
    for (const [file, entry] of this.files) {
      for (const symbol of entry.symbols) {
        const refs = this.byName.get(symbol.name) ?? [];
        refs.push({ file, symbol });
        this.byName.set(symbol.name, refs);
      }
    }
  }

  private persist(): void {
    try {
      mkdirSync(dirname2(this.storePath), { recursive: true });
      const serializable: Record<string, FileEntry> = {};
      for (const [file, entry] of this.files) {
        serializable[relative(this.projectPath, file)] = entry;
      }
      writeFileSync(
        this.storePath,
        JSON.stringify({ version: 1, root: this.projectPath, files: serializable }),
      );
    } catch {
      // Persistence is best-effort; the in-memory index keeps working.
    }
  }
}

function enclosingOf(symbols: IndexedSymbol[], line: number): string | undefined {
  let best: IndexedSymbol | undefined;
  for (const candidate of symbols) {
    if (candidate.line <= line && line <= candidate.endLine) {
      // Narrowest containing span wins (method over its class).
      if (!best || candidate.endLine - candidate.line < best.endLine - best.line) {
        best = candidate;
      }
    }
  }
  return best?.name;
}

function dirname2(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? path : path.slice(0, index);
}

export function projectStorePath(agentDir: string, projectPath: string): string {
  const hash = createHash("sha1").update(projectPath).digest("hex").slice(0, 12);
  return join(agentDir, "codegraph", `${hash}.json`);
}
