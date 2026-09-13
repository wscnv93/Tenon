import { execFile } from "node:child_process";
import { simpleGit, type SimpleGit } from "simple-git";
import { parseUnifiedDiff } from "@protocol/diff.js";
import type { FileChange, FileDiff, GitStatus } from "@protocol/ipc";

/**
 * Git operations for the review pane. One SimpleGit client per project path
 * (cheap; simpleGit just wraps child git calls). All throw on non-repo paths —
 * callers surface "not a repository" as an empty status.
 */

const gitClients = new Map<string, SimpleGit>();

function gitFor(projectPath: string): SimpleGit {
  let git = gitClients.get(projectPath);
  if (!git) {
    git = simpleGit({ baseDir: projectPath });
    gitClients.set(projectPath, git);
  }
  return git;
}

// ---------------------------------------------------------------------------
// Result cache: tab switches must not re-pay git subprocesses. Short TTL +
// explicit invalidation whenever git state changes (agent settles, staging,
// discards).
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 4000;
const statusCache = new Map<string, { at: number; status: GitStatus }>();
const diffCache = new Map<string, { at: number; diff: { files: FileDiff[]; base?: string } }>();

export function invalidateGitCache(projectPath?: string): void {
  if (projectPath) {
    statusCache.delete(projectPath);
    for (const key of [...diffCache.keys()]) {
      if (diffCache.get(key)!.diff && key.startsWith(projectPath)) diffCache.delete(key);
    }
  } else {
    statusCache.clear();
    diffCache.clear();
  }
}

function diffKey(projectPath: string, scope: string, view: string): string {
  return `${projectPath}::${scope}::${view}`;
}

export async function gitStatus(projectPath: string): Promise<GitStatus> {
  const cached = statusCache.get(projectPath);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.status;
  const git = gitFor(projectPath);
  if (!(await isRepo(git))) return emptyStatus();
  const status = await git.status();
  const changes: FileChange[] = [];
  for (const file of status.files) {
    const index = file.index;
    const workTree = file.working_dir;
    let staged = false;
    let statusLetter: FileChange["status"] = "M";
    if (index !== " " && index !== "?") {
      staged = true;
      statusLetter = toStatus(index);
    } else if (workTree !== " ") {
      statusLetter = workTree === "?" ? "A" : toStatus(workTree);
    } else {
      continue;
    }
    changes.push({ path: file.path, status: statusLetter, staged });
  }
  const result: GitStatus = {
    isRepo: true,
    branch: status.current ?? null,
    ahead: status.ahead ?? 0,
    behind: status.behind ?? 0,
    changes,
  };
  statusCache.set(projectPath, { at: Date.now(), status: result });
  return result;
}

/** Files changed since the last turn snapshot (symmetric difference). */
export async function diffFiles(
  projectPath: string,
  scope: "uncommitted" | "branch" | "turn",
  view: "worktree" | "staged",
  turnPaths?: readonly string[],
): Promise<{ files: FileDiff[]; base?: string }> {
  const key = diffKey(projectPath, scope, view);
  const cachedDiff = diffCache.get(key);
  if (cachedDiff && Date.now() - cachedDiff.at < CACHE_TTL_MS) return cachedDiff.diff;
  const git = gitFor(projectPath);
  if (!(await isRepo(git))) return { files: [] };
  const args: string[] = ["--no-color", "-U3"];
  const hasHead = await hasHeadRef(git);

  if (scope === "branch") {
    const base = await resolveBranchBase(git);
    if (!base) return { files: [] };
    const text = await git.raw(["diff", "--no-color", `${base}...HEAD`]);
    const result = { files: parseUnifiedDiff(text), base };
    diffCache.set(key, { at: Date.now(), diff: result });
    return result;
  }

  if (scope === "turn") {
    const paths = turnPaths ?? [];
    if (paths.length === 0) return { files: [] };
    const text = hasHead
      ? await git.raw(["diff", "HEAD", "--no-color", "--", ...paths])
      : await git.raw(["diff", "--no-color", "--", ...paths]);
    const result = { files: parseUnifiedDiff(text) };
    diffCache.set(key, { at: Date.now(), diff: result });
    return result;
  }

  // uncommitted
  if (view === "staged") {
    const text = await git.raw(["diff", "--cached", "--no-color"]);
    const result = { files: parseUnifiedDiff(text) };
    diffCache.set(key, { at: Date.now(), diff: result });
    return result;
  }
  const text = hasHead
    ? await git.raw(["diff", "HEAD", "--no-color"])
    : await git.raw(["diff", "--no-color"]);
  const files = parseUnifiedDiff(text);

  // `git diff` never lists untracked files — synthesize "new file" diffs for
  // them so the review pane shows the full worktree picture.
  if (scope === "uncommitted") {
    const status = await gitStatus(projectPath);
    const known = new Set(files.map((file) => file.path));
    for (const change of status.changes) {
      if (change.staged || known.has(change.path) || change.status === "D") continue;
      try {
        const untrackedText = await git.raw(["diff", "--no-color", "--no-index", "--", "/dev/null", change.path]);
        files.push(...parseUnifiedDiff(untrackedText));
      } catch (err) {
        // git diff --no-index exits 1 when differences exist; simple-git
        // throws on non-zero — the output is still on the error object.
        const output = (err as { stdout?: string })?.stdout;
        if (typeof output === "string" && output.length > 0) {
          files.push(...parseUnifiedDiff(output));
        }
      }
    }
  }
  const result = { files };
  diffCache.set(key, { at: Date.now(), diff: result });
  return result;
}

export async function stageFile(projectPath: string, path: string): Promise<void> {
  await gitFor(projectPath).add(["--", path]);
}

export async function unstageFile(projectPath: string, path: string): Promise<void> {
  const git = gitFor(projectPath);
  if (await hasHeadRef(git)) {
    await git.raw(["reset", "HEAD", "--", path]);
  } else {
    // No commits yet: the index compares against the empty tree.
    await git.raw(["rm", "--cached", "-r", "--ignore-unmatch", "--", path]);
  }
}

export async function discardFile(projectPath: string, path: string): Promise<void> {
  const git = gitFor(projectPath);
  let tracked = true;
  try {
    await git.raw(["ls-files", "--error-unmatch", "--", path]);
  } catch {
    tracked = false;
  }
  if (!tracked) {
    await git.raw(["clean", "-f", "--", path]);
    return;
  }
  if (await hasHeadRef(git)) {
    await git.raw(["checkout", "HEAD", "--", path]);
  } else {
    await git.raw(["rm", "-f", "--", path]);
  }
}

/**
 * Apply a patch through git's stdin (simple-git's raw() cannot pipe input).
 * git apply requires the payload to end with exactly one trailing newline.
 */
function applyPatch(projectPath: string, args: string[], patch: string): Promise<void> {
  const normalized = `${patch.replace(/\n+$/, "")}\n`;
  return new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      args,
      { cwd: projectPath, maxBuffer: 64 * 1024 * 1024 },
      (error, _stdout, stderr) => {
        if (error) reject(new Error(`git ${args.join(" ")} 失败:${stderr || error.message}`));
        else resolve();
      },
    );
    child.on("error", reject);
    child.stdin?.end(normalized);
  });
}

export async function stageHunk(projectPath: string, _path: string, patch: string): Promise<void> {
  await applyPatch(projectPath, ["apply", "--cached", "--whitespace=nowarn"], patch);
}

export async function unstageHunk(projectPath: string, _path: string, patch: string): Promise<void> {
  await applyPatch(projectPath, ["apply", "--cached", "--reverse", "--whitespace=nowarn"], patch);
}

export async function discardHunk(projectPath: string, _path: string, patch: string): Promise<void> {
  await applyPatch(projectPath, ["apply", "--reverse", "--whitespace=nowarn"], patch);
}

export async function stageAll(projectPath: string): Promise<void> {
  await gitFor(projectPath).raw(["add", "-A"]);
}

export async function unstageAll(projectPath: string): Promise<void> {
  const git = gitFor(projectPath);
  if (await hasHeadRef(git)) {
    await git.raw(["reset"]);
  } else {
    await git.raw(["rm", "--cached", "-r", "--ignore-unmatch", "."]);
  }
}

// ---------------------------------------------------------------------------
// Turn snapshots: capture before a prompt, diff on agent_settled.
// ---------------------------------------------------------------------------

export interface TurnSnapshot {
  head: string | null;
  paths: Set<string>;
}

export async function captureSnapshot(projectPath: string): Promise<TurnSnapshot> {
  const git = gitFor(projectPath);
  if (!(await isRepo(git))) return { head: null, paths: new Set() };
  const head = await hasHeadRef(git) ? (await git.raw(["rev-parse", "HEAD"])).trim() : null;
  const status = await git.status();
  return { head, paths: new Set(status.files.map((file) => file.path)) };
}

export function diffSnapshots(before: TurnSnapshot, after: TurnSnapshot): string[] {
  const changed = new Set<string>();
  for (const path of after.paths) if (!before.paths.has(path)) changed.add(path);
  for (const path of before.paths) if (!after.paths.has(path)) changed.add(path);
  if (before.head !== after.head) {
    // The turn produced commits — surface every file between the two heads.
    // Callers pass commit ranges separately if needed; path set is the M1 proxy.
  }
  return [...changed];
}

// ---------------------------------------------------------------------------

async function isRepo(git: SimpleGit): Promise<boolean> {
  try {
    const isRepo = await git.checkIsRepo();
    return isRepo;
  } catch {
    return false;
  }
}

async function hasHeadRef(git: SimpleGit): Promise<boolean> {
  try {
    await git.raw(["rev-parse", "--verify", "HEAD"]);
    return true;
  } catch {
    return false;
  }
}

async function resolveBranchBase(git: SimpleGit): Promise<string | null> {
  const candidates: string[] = [
    "@{upstream}",
    "origin/main",
    "origin/master",
    "main",
    "master",
    "origin/trunk",
    "trunk",
  ];
  for (const candidate of candidates) {
    try {
      await git.raw(["rev-parse", "--verify", candidate]);
      return candidate === "@{upstream}" ? "@{upstream}" : candidate;
    } catch {
      // try next
    }
  }
  return null;
}

function toStatus(letter: string): FileChange["status"] {
  if (letter === "A") return "A";
  if (letter === "D") return "D";
  if (letter === "R") return "R";
  return "M";
}

function emptyStatus(): GitStatus {
  return { isRepo: false, branch: null, ahead: 0, behind: 0, changes: [] };
}
