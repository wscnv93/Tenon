import { useEffect, useRef, useState } from "react";
import { useSetAtom } from "jotai";
import { api } from "../lib/api";
import { agentStoreAtom } from "../state";

/**
 * Branch tree for the active session (pi sessions are trees; RPC `fork`
 * rewinds the session to a chosen entry, creating a new branch).
 */

interface TreeNodeShape {
  entry: {
    id: string;
    type: string;
    message?: { role: string; content: unknown };
    label?: unknown;
  };
  children?: TreeNodeShape[];
  label?: string;
}

export function SessionTree({
  anchor,
  projectPath,
  onClose,
}: {
  anchor: DOMRect;
  projectPath: string;
  onClose: () => void;
}) {
  const setAgentStore = useSetAtom(agentStoreAtom);
  const [nodes, setNodes] = useState<TreeNodeShape[] | null>(null);
  const [leafId, setLeafId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void (async () => {
      try {
        const result = await api.agentGetTree(projectPath);
        setNodes((result.tree as TreeNodeShape[]) ?? []);
        setLeafId(result.leafId ?? null);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, [projectPath]);

  useEffect(() => {
    const onDown = (event: MouseEvent): void => {
      if (cardRef.current && !cardRef.current.contains(event.target as Node)) onClose();
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const fork = async (entryId: string): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await api.agentForkAt(projectPath, entryId);
      setAgentStore((prev) => ({ ...prev, state: result.state, messages: result.messages, toolRuns: {}, notices: [] }));
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const top = Math.min(anchor.bottom + 6, window.innerHeight - 360);
  const left = Math.min(anchor.left, window.innerWidth - 290);

  return (
    <div className="tree-card" ref={cardRef} style={{ position: "fixed", top, left }} role="dialog">
      <div className="tree-title">会话分支 · 点击任意消息分叉续跑</div>
      <div className="tree-body">
        {error && <div className="pane-note pane-note-error">{error}</div>}
        {nodes === null && !error && <div className="pane-note">加载分支树…</div>}
        {nodes !== null && <TreeLevel nodes={nodes} leafId={leafId} onFork={fork} depth={0} />}
      </div>
    </div>
  );
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((block: any) => block?.type === "text")
      .map((block: any) => block.text as string)
      .join(" ");
  }
  return "";
}

function TreeLevel({
  nodes,
  leafId,
  onFork,
  depth,
}: {
  nodes: TreeNodeShape[];
  leafId: string | null;
  onFork: (entryId: string) => void;
  depth: number;
}) {
  return (
    <>
      {nodes.map((node, i) => {
        const isUser = node.entry.type === "message" && node.entry.message?.role === "user";
        const isLeaf = node.entry.id === leafId;
        const summary = isUser ? textOf(node.entry.message?.content).slice(0, 60) : nodeLabel(node);
        if (!summary && !isUser) {
          return <TreeLevel key={node.entry.id + i} nodes={node.children ?? []} leafId={leafId} onFork={onFork} depth={depth} />;
        }
        return (
          <div key={node.entry.id + i}>
            <button
              type="button"
              className={`tree-node ${isLeaf ? "tree-leaf" : ""} ${isUser ? "tree-user" : ""}`}
              style={{ paddingLeft: 8 + depth * 14 }}
              title={isUser ? "从此处分叉" : undefined}
              onClick={() => isUser && onFork(node.entry.id)}
              disabled={!isUser}
            >
              <span className="tree-marker">{isUser ? "◆" : "·"}</span>
              <span className="tree-text">{summary || "(空)"}</span>
              {isLeaf && <span className="tree-now">当前</span>}
            </button>
            <TreeLevel nodes={node.children ?? []} leafId={leafId} onFork={onFork} depth={depth + 1} />
          </div>
        );
      })}
    </>
  );
}

function nodeLabel(node: TreeNodeShape): string {
  if (node.entry.type === "compaction") return "⟲ 上下文压缩点";
  if (node.entry.type === "model_change") return "⟳ 模型切换";
  if (node.entry.type === "session") return "";
  return "";
}
