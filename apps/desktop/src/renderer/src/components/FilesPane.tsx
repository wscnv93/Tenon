import { useCallback, useEffect, useState } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { api } from "../lib/api";
import { statusLabel } from "@protocol/diff";
import type { GitStatus } from "@protocol/ipc";
import { activeProjectAtom, agentSettledTickAtom, composerInsertAtom, reviewFocusAtom, rightTabAtom } from "../state";

export function FilesPane() {
  const project = useAtomValue(activeProjectAtom);
  const settledTick = useAtomValue(agentSettledTickAtom);
  const setRightTab = useSetAtom(rightTabAtom);
  const setReviewFocus = useSetAtom(reviewFocusAtom);
  const setInsert = useSetAtom(composerInsertAtom);
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [loading, setLoading] = useState(false);

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

  if (!project) return <div className="pane-empty">未选择项目</div>;
  if (status && !status.isRepo) return <div className="pane-empty">当前项目不是 Git 仓库</div>;

  return (
    <div className="files-pane">
      <div className="review-toolbar">
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
      {status && status.changes.length === 0 && <div className="pane-empty">没有变更文件</div>}
      <div className="files-list">
        {status?.changes.map((change) => (
          <div key={`${change.path}${change.staged ? "*" : ""}`} className="file-row">
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
              <span className="file-row-path">{change.path}</span>
            </button>
            {change.staged && <span className="file-row-staged" title="已暂存">■</span>}
            <button
              type="button"
              className="icon-btn"
              title="以 @路径 插入输入框"
              onClick={() => setInsert({ text: `@${change.path} `, nonce: Date.now() })}
            >
              @
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
