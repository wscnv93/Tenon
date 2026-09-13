import type { DiffHunk, DiffLine, FileDiff, FileChangeStatus } from "./ipc.js";

/**
 * Parse a unified diff (git output) into FileDiff view models.
 *
 * Pure function shared by the main process (git service) and the renderer
 * (edit/write tool cards render `details.diff` with the same parser).
 *
 * Layout notes: file sections start with "diff --git"; rename metadata may
 * replace the ---/+++ pair; "\ No newline at end of file" lines belong to the
 * preceding line and are kept out of hunk line counts; binary files carry no
 * hunks.
 */
export function parseUnifiedDiff(text: string): FileDiff[] {
  const files: FileDiff[] = [];
  const lines = text.split("\n");
  let i = 0;

  const currentFile = (): FileDiff | null => files[files.length - 1] ?? null;

  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith("diff --git ")) {
      const match = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
      const path = match?.[2] ?? line.slice(11);
      files.push({
        path,
        oldPath: null,
        status: "M",
        additions: 0,
        deletions: 0,
        binary: false,
        hunks: [],
        patch: "",
      });
      i++;
      continue;
    }

    const file = currentFile();
    if (!file) {
      i++;
      continue;
    }

    if (line.startsWith("old mode") || line.startsWith("new mode") || line.startsWith("index ")) {
      i++;
      continue;
    }
    if (line.startsWith("similarity index") || line.startsWith("dissimilarity index")) {
      i++;
      continue;
    }
    if (line.startsWith("rename from ")) {
      file.oldPath = line.slice("rename from ".length);
      file.status = "R";
      i++;
      continue;
    }
    if (line.startsWith("rename to ")) {
      file.path = line.slice("rename to ".length);
      file.status = "R";
      i++;
      continue;
    }
    if (line.startsWith("copy from ") || line.startsWith("copy to ")) {
      i++;
      continue;
    }
    if (line.startsWith("deleted file mode ")) {
      file.status = "D";
      i++;
      continue;
    }
    if (line.startsWith("new file mode ")) {
      file.status = "A";
      i++;
      continue;
    }
    if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
      file.binary = true;
      i++;
      continue;
    }
    if (line.startsWith("--- ")) {
      const old = stripAB(line.slice(4));
      if (old && old !== "/dev/null" && file.status !== "R") file.oldPath = old;
      if (old === "/dev/null") file.status = "A";
      i++;
      continue;
    }
    if (line.startsWith("+++ ")) {
      const neu = stripAB(line.slice(4));
      if (neu && neu !== "/dev/null") file.path = neu;
      i++;
      continue;
    }

    if (line.startsWith("@@")) {
      const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
      const hunk: DiffHunk = {
        header: match?.[3]?.trim() ?? "",
        oldStart: match ? Number(match[1]) : 0,
        newStart: match ? Number(match[2]) : 0,
        lines: [],
        patch: "",
      };
      const hunkBodyStart = i;
      let oldNo = hunk.oldStart;
      let newNo = hunk.newStart;
      i++;
      while (i < lines.length) {
        const body = lines[i]!;
        if (body.startsWith("diff --git ") || body.startsWith("@@")) break;
        if (body.startsWith("\\")) {
          i++;
          continue;
        }
        if (body.startsWith("+")) {
          hunk.lines.push({ kind: "add", text: body.slice(1), oldNo: null, newNo: newNo++ });
          file.additions++;
        } else if (body.startsWith("-")) {
          hunk.lines.push({ kind: "del", text: body.slice(1), oldNo: oldNo++, newNo: null });
          file.deletions++;
        } else if (body.startsWith(" ")) {
          hunk.lines.push({ kind: "ctx", text: body.slice(1), oldNo: oldNo++, newNo: newNo++ });
        } else if (body === "") {
          // Trailing newline of the diff text — treat as context-less end.
          const next = lines[i + 1];
          if (next === undefined || next.startsWith("diff --git ")) break;
          hunk.lines.push({ kind: "ctx", text: "", oldNo: oldNo++, newNo: newNo++ });
        } else {
          break;
        }
        i++;
      }
      hunk.patch = lines.slice(hunkBodyStart, i).join("\n");
      file.hunks.push(hunk);
      continue;
    }

    i++;
  }

  for (const file of files) {
    const start = text.indexOf(`diff --git a/${file.oldPath ?? file.path}`);
    const nextStart =
      start === -1 ? -1 : (() => {
        const from = text.indexOf("\ndiff --git ", start + 1);
        return from === -1 ? text.length : from + 1;
      })();
    file.patch = start === -1 ? "" : text.slice(start, nextStart).trimEnd();
    for (const hunk of file.hunks) {
      hunk.patch = `${fileHeaderFor(file)}\n${hunk.patch}`;
    }
  }

  return files;
}

function fileHeaderFor(file: FileDiff): string {
  const oldPath = file.oldPath ?? file.path;
  const lines = [`diff --git a/${oldPath} b/${file.path}`];
  if (file.status === "R") {
    lines.push(`rename from ${oldPath}`, `rename to ${file.path}`);
  } else if (file.status === "A") {
    lines.push("new file mode 100644");
  } else if (file.status === "D") {
    lines.push("deleted file mode 100644");
  }
  lines.push(`--- ${file.status === "A" ? "/dev/null" : `a/${oldPath}`}`);
  lines.push(`+++ ${file.status === "D" ? "/dev/null" : `b/${file.path}`}`);
  return lines.join("\n");
}

function stripAB(path: string): string {
  if (path.startsWith("a/") || path.startsWith("b/")) return path.slice(2);
  return path;
}

export function statusLabel(status: FileChangeStatus): string {
  return status === "M" ? "修改" : status === "A" ? "新增" : status === "D" ? "删除" : "重命名";
}
