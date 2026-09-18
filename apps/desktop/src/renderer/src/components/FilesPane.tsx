import { useCallback, useEffect, useMemo, useState } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { api } from "../lib/api";
import { statusLabel } from "@protocol/diff";
import type { FileChange, GitStatus } from "@protocol/ipc";
import { GraphView } from "./GraphView";

interface DirEntry {
  name: string;
  isDir: boolean;
}
import { activeProjectAtom, agentSettledTickAtom, composerInsertAtom, reviewFocusAtom, rightTabAtom } from "../state";

interface TreeNode {
  name: string;
  /** Full path with "/" separators; directories end without a trailing slash. */
  path: string;
  file?: FileChange;
  children: Map<string, TreeNode>;
}

function buildTree(changes: FileChange[]): TreeNode {
  const root: TreeNode = { name: "", path: "", children: new Map() };
  for (const change of changes) {
    const segments = change.path.split("/");
    let node = root;
    for (let i = 0; i < segments.length; i++) {
      const isLeaf = i === segments.length - 1;
      const path = segments.slice(0, i + 1).join("/");
      const name = segments[i]!;
      let child = node.children.get(name);
      if (!child) {
        child = { name, path, children: new Map() };
        node.children.set(name, child);
      }
      if (isLeaf) child.file = change;
      node = child;
    }
  }
  return root;
}

function countFiles(node: TreeNode): number {
  if (node.file) return 1;
  let total = 0;
  for (const child of node.children.values()) total += countFiles(child);
  return total;
}

function sortedChildren(node: TreeNode): TreeNode[] {
  const dirs: TreeNode[] = [];
  const files: TreeNode[] = [];
  for (const child of node.children.values()) {
    if (child.file && child.children.size === 0) files.push(child);
    else dirs.push(child);
  }
  const byName = (a: TreeNode, b: TreeNode): number => a.name.localeCompare(b.name);
  return [...dirs.sort(byName), ...files.sort(byName)];
}

export function FilesPane() {
  const project = useAtomValue(activeProjectAtom);
  const settledTick = useAtomValue(agentSettledTickAtom);
  const setRightTab = useSetAtom(rightTabAtom);
  const setReviewFocus = useSetAtom(reviewFocusAtom);
  const setInsert = useSetAtom(composerInsertAtom);
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [showGraph, setShowGraph] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    if (!project) return;
    setLoading(true);
    try {
      setStatus(await api.gitStatus(project.path));
    } finally {
      setLoading(false);
    }
  }, [project]);

  useEffect(() => {
    void load();
  }, [load, settledTick]);

  const tree = useMemo(() => (status ? buildTree(status.changes) : null), [status]);

  const toggleDir = (path: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  if (!project) return <div className="pane-empty">未选择项目</div>;
  if (showGraph) {
    return <GraphView onClose={() => setShowGraph(false)} />;
  }
  if (status && !status.isRepo) {
    return <ProjectBrowser projectPath={project.path} />;
  }

  const renderNode = (node: TreeNode, depth: number): React.ReactNode => {
    if (node.file && node.children.size === 0) {
      const change = node.file;
      return (
        <div key={`f:${change.path}`} className="file-row" style={{ paddingLeft: 4 + depth * 14 }}>
          <button
            type="button"
            className="file-row-main"
            title={`${change.path} — 点击在检视中查看`}
            onClick={() => {
              setRightTab("review");
              setReviewFocus(change.path);
            }}
          >
            <span className={`file-row-status st-${change.status}`}>{statusLabel(change.status)}</span>
            <span className="file-row-path">{node.name}</span>
          </button>
          {change.staged && (
            <span className="file-row-staged" title="已暂存">
              ■
            </span>
          )}
          <button
            type="button"
            className="icon-btn"
            title="以 @路径 插入输入框"
            onClick={() => setInsert({ text: `@${change.path} `, nonce: Date.now() })}
          >
            @
          </button>
        </div>
      );
    }

    const isCollapsed = collapsed.has(node.path);
    const count = countFiles(node);
    return (
      <div key={`d:${node.path}`}>
        <button
          type="button"
          className="dir-row"
          style={{ paddingLeft: 4 + depth * 14 }}
          onClick={() => toggleDir(node.path)}
          title={node.path}
        >
          <span className="tool-caret">{isCollapsed ? "▸" : "▾"}</span>
          <span className="dir-name">{node.name}</span>
          <span className="dir-count">{count}</span>
        </button>
        {!isCollapsed && sortedChildren(node).map((child) => renderNode(child, depth + 1))}
      </div>
    );
  };

  return (
    <div className="files-pane">
      <div className="review-toolbar">
        <span className="pane-label">Git 变更</span>
        <button type="button" className="chip chip-graph" title="展示文件依赖关系图(codegraph)" onClick={() => setShowGraph(true)}>
          ⛭ 关系图
        </button>
        {status?.branch && (
          <span className="chip">
            {status.branch}
            {status.ahead > 0 && <span className="diff-add-num"> ↑{status.ahead}</span>}
            {status.behind > 0 && <span className="diff-del-num"> ↓{status.behind}</span>}
          </span>
        )}
        <span className="review-totals">{status?.changes.length ?? 0} 个变更</span>
        <button type="button" className="icon-btn" title="刷新" onClick={() => void load()}>
          ⟳
        </button>
      </div>
      {loading && !status && <div className="pane-note">读取仓库状态…</div>}
      {status && status.changes.length === 0 && (
        <div className="pane-empty">
          工作区干净,没有未提交的更改
          <br />
          <span className="pane-empty-sub">agent 改动文件后会实时出现在这里;点击文件即可在检视中查看差异</span>
        </div>
      )}
      {tree && status && status.changes.length > 0 && (
        <div className="files-tree">{sortedChildren(tree).map((child) => renderNode(child, 0))}</div>
      )}
    </div>
  );
}


/**
 * Non-git fallback: a lazy directory browser so the pane never dead-ends.
 */
function ProjectBrowser({ projectPath }: { projectPath: string }) {
  const setInsert = useSetAtom(composerInsertAtom);
  const [root, setRoot] = useState<DirEntry[] | null>(null);
  const [expanded, setExpanded] = useState<Record<string, DirEntry[] | "loading">>({});

  useEffect(() => {
    setExpanded({});
    void api.listProjectDir(projectPath).then((result) => setRoot(result.entries as DirEntry[]));
  }, [projectPath]);

  const toggleDir = async (rel: string): Promise<void> => {
    if (expanded[rel]) {
      setExpanded((prev) => {
        const next = { ...prev };
        delete next[rel];
        return next;
      });
      return;
    }
    setExpanded((prev) => ({ ...prev, [rel]: "loading" }));
    const result = await api.listProjectDir(projectPath, rel);
    setExpanded((prev) => ({ ...prev, [rel]: result.entries as DirEntry[] }));
  };

  const renderEntries = (entries: DirEntry[], depth: number, parent = ""): React.ReactNode =>
    entries.map((entry) => {
      const rel = parent ? `${parent}/${entry.name}` : entry.name;
      if (entry.isDir) {
        const children = expanded[rel];
        return (
          <div key={rel}>
            <button type="button" className="dir-row" style={{ paddingLeft: 4 + depth * 14 }} onClick={() => void toggleDir(rel)}>
              <span className="tool-caret">{children ? "▾" : "▸"}</span>
              <span className="dir-name">{entry.name}</span>
            </button>
            {children === "loading" && <div className="pane-note" style={{ paddingLeft: 8 + depth * 14 }}>读取…</div>}
            {Array.isArray(children) && renderEntries(children, depth + 1, rel)}
          </div>
        );
      }
      return (
        <div key={rel} className="file-row" style={{ paddingLeft: 4 + depth * 14 }}>
          <button
            type="button"
            className="file-row-main"
            title={`${rel} — 点击以 @路径 插入输入框`}
            onClick={() => setInsert({ text: `@${rel} `, nonce: Date.now() })}
          >
            <span className="file-row-path">{entry.name}</span>
          </button>
          <button
            type="button"
            className="icon-btn"
            title="以 @路径 插入输入框"
            onClick={() => setInsert({ text: `@${rel} `, nonce: Date.now() })}
          >
            @
          </button>
        </div>
      );
    });

  return (
    <div className="files-pane">
      <div className="review-toolbar">
        <span className="pane-label">文件浏览</span>
        <span className="review-totals">当前项目未初始化 Git,仅提供文件浏览</span>
      </div>
      <div className="files-tree">
        {root === null && <div className="pane-note">读取目录…</div>}
        {root?.length === 0 && <div className="pane-empty">目录为空</div>}
        {root && renderEntries(root, 0)}
      </div>
    </div>
  );
}
