import { useCallback, useEffect, useMemo, useState } from "react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { api } from "../lib/api";
import { HunkView } from "./DiffView";
import { statusLabel } from "@protocol/diff";
import type { FileDiff, ReviewComment } from "@protocol/ipc";
import {
  activeProjectAtom,
  agentStoreAtom,
  agentSettledTickAtom,
  reviewFocusAtom,
} from "../state";

type Scope = "uncommitted" | "branch" | "turn";
type View = "worktree" | "staged";

const SCOPE_LABEL: Record<Scope, string> = {
  uncommitted: "未提交",
  branch: "本分支",
  turn: "本轮",
};

export function ReviewPane() {
  const project = useAtomValue(activeProjectAtom);
  const store = useAtomValue(agentStoreAtom);
  const settledTick = useAtomValue(agentSettledTickAtom);
  const setReviewFocus = useSetAtom(reviewFocusAtom);
  const [scope, setScope] = useState<Scope>("uncommitted");
  const [view, setView] = useState<View>("worktree");
  const [files, setFiles] = useState<FileDiff[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [comments, setComments] = useState<Record<string, string>>({});
  const [commentDraft, setCommentDraft] = useState<{ path: string; line: number } | null>(null);
  const [focus, setFocus] = useAtom(reviewFocusAtom);

  const load = useCallback(async (): Promise<void> => {
    if (!project) return;
    setLoading(true);
    setError(null);
    try {
      const result = await api.gitDiff(project.path, scope, view);
      setFiles(result.files);
    } catch (err) {
      setFiles([]);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [project, scope, view]);

  useEffect(() => {
    void load();
  }, [load, settledTick]);

  // Consume focus requests from the files pane.
  useEffect(() => {
    if (!focus) return;
    setExpanded((prev) => new Set([...prev, focus!]));
    setScope("uncommitted");
    requestAnimationFrame(() => {
      document.getElementById(`diff-file-${CSS.escape(focus!)}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    setFocus(null);
  }, [focus, setFocus]);

  const commentList = useMemo(
    () => Object.entries(comments).map(([key, text]) => {
      const [path, line] = key.split("#");
      return { path: path!, line: Number(line), text };
    }),
    [comments],
  );

  const act = async (fn: () => Promise<unknown>): Promise<void> => {
    try {
      await fn();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  if (!project) return <div className="pane-empty">未选择项目</div>;

  const totals = files.reduce((acc, file) => ({ add: acc.add + file.additions, del: acc.del + file.deletions }), { add: 0, del: 0 });

  return (
    <div className="review-pane">
      <div className="review-toolbar">
        <select className="chip chip-select" value={scope} onChange={(event) => setScope(event.target.value as Scope)}>
          {(Object.keys(SCOPE_LABEL) as Scope[]).map((key) => (
            <option key={key} value={key}>
              {SCOPE_LABEL[key]}
            </option>
          ))}
        </select>
        {scope === "uncommitted" && (
          <div className="seg">
            <button type="button" className={view === "worktree" ? "on" : ""} onClick={() => setView("worktree")}>
              工作区
            </button>
            <button type="button" className={view === "staged" ? "on" : ""} onClick={() => setView("staged")}>
              已暂存
            </button>
          </div>
        )}
        <span className="review-totals">
          {files.length} 文件 · <span className="diff-add-num">+{totals.add}</span>{" "}
          <span className="diff-del-num">−{totals.del}</span>
        </span>
        <button type="button" className="icon-btn" title="刷新" onClick={() => void load()}>
          ⟳
        </button>
      </div>

      {scope === "uncommitted" && files.length > 0 && (
        <div className="review-bulk">
          {view === "worktree" ? (
            <>
              <button type="button" className="link" onClick={() => void act(() => api.gitStageAll(project.path))}>
                全部暂存
              </button>
              <button
                type="button"
                className="link link-danger"
                onClick={() => {
                  if (window.confirm("回退所有未提交更改?此操作不可撤销。")) {
                    void act(async () => {
                      await api.gitUnstageAll(project.path);
                      await api.gitDiff(project.path, "uncommitted", "worktree").then(async (result) => {
                        for (const file of result.files) {
                          await api.gitDiscardFile(project.path, file.path);
                        }
                      });
                    });
                  }
                }}
              >
                全部回退
              </button>
            </>
          ) : (
            <button type="button" className="link" onClick={() => void act(() => api.gitUnstageAll(project.path))}>
              全部取消暂存
            </button>
          )}
        </div>
      )}

      {error && <div className="pane-note pane-note-error">{error}</div>}
      {loading && files.length === 0 && <div className="pane-note">加载差异…</div>}
      {!loading && files.length === 0 && !error && (
        <div className="pane-empty">
          {scope === "turn" ? "本轮没有检测到文件改动" : scope === "branch" ? "本分支相对基线没有差异,或未找到基线分支" : "工作区干净,没有未提交更改"}
        </div>
      )}

      <div className="review-files">
        {files.map((file) => {
          const open = expanded.has(file.path);
          return (
            <div key={file.path} id={`diff-file-${CSS.escape(file.path)}`} className="file-card">
              <div className="file-card-header">
                <button
                  type="button"
                  className="file-card-path"
                  title={file.path}
                  onClick={() =>
                    setExpanded((prev) => {
                      const next = new Set(prev);
                      if (next.has(file.path)) next.delete(file.path);
                      else next.add(file.path);
                      return next;
                    })
                  }
                >
                  <span className="tool-caret">{open ? "▾" : "▸"}</span>
                  <span className="file-card-status">{statusLabel(file.status)}</span>
                  <span className="file-card-name">{file.path}</span>
                </button>
                <span className="file-card-counts">
                  <span className="diff-add-num">+{file.additions}</span> <span className="diff-del-num">−{file.deletions}</span>
                </span>
                {scope === "uncommitted" && (
                  <span className="file-card-actions">
                    {view === "worktree" ? (
                      <>
                        <button type="button" className="link" onClick={() => void act(() => api.gitStageFile(project.path, file.path))}>
                          暂存
                        </button>
                        <button
                          type="button"
                          className="link link-danger"
                          onClick={() => {
                            if (window.confirm(`回退 ${file.path} 的全部未提交更改?`)) {
                              void act(() => api.gitDiscardFile(project.path, file.path));
                            }
                          }}
                        >
                          回退
                        </button>
                      </>
                    ) : (
                      <button type="button" className="link" onClick={() => void act(() => api.gitUnstageFile(project.path, file.path))}>
                        取消暂存
                      </button>
                    )}
                  </span>
                )}
              </div>
              {open && (
                <div className="file-card-body">
                  {file.binary && <div className="diff-empty">二进制文件</div>}
                  {file.hunks.map((hunk, hi) => (
                    <div key={hi} className="diff-hunk-wrap">
                      {scope === "uncommitted" && !file.binary && (
                        <div className="hunk-actions">
                          {view === "worktree" ? (
                            <>
                              <button type="button" className="link" onClick={() => void act(() => api.gitStageHunk(project.path, file.path, hunk.patch))}>
                                暂存此块
                              </button>
                              <button
                                type="button"
                                className="link link-danger"
                                onClick={() => {
                                  if (window.confirm(`回退 ${file.path} 的此差异块?`)) {
                                    void act(() => api.gitDiscardHunk(project.path, file.path, hunk.patch));
                                  }
                                }}
                              >
                                回退此块
                              </button>
                            </>
                          ) : (
                            <button type="button" className="link" onClick={() => void act(() => api.gitUnstageHunk(project.path, file.path, hunk.patch))}>
                              取消暂存此块
                            </button>
                          )}
                        </div>
                      )}
                      <HunkView
                        hunk={hunk}
                        commentFor={(lineNo) => comments[`${file.path}#${lineNo}`]}
                        onLineComment={(lineNo) => setCommentDraft({ path: file.path, line: lineNo })}
                      />
                    </div>
                  ))}
                  {commentDraft?.path === file.path && (
                    <div className="diff-comment-editor">
                      <span className="diff-comment-anchor">
                        {file.path}:{commentDraft.line}
                      </span>
                      <textarea
                        autoFocus
                        rows={2}
                        placeholder="检视意见…"
                        onChange={(event) =>
                          setComments((prev) => ({ ...prev, [`${file.path}#${commentDraft.line}`]: event.target.value }))
                        }
                        value={comments[`${file.path}#${commentDraft.line}`] ?? ""}
                      />
                      <div className="diff-comment-editor-actions">
                        <button
                          type="button"
                          className="btn btn-small"
                          onClick={() => {
                            setComments((prev) => {
                              const next = { ...prev };
                              delete next[`${file.path}#${commentDraft.line}`];
                              return next;
                            });
                            setCommentDraft(null);
                          }}
                        >
                          取消
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {commentList.length > 0 && (
        <div className="review-send-bar">
          <span>{commentList.length} 条检视意见</span>
          <button
            type="button"
            className="btn btn-send"
            onClick={() => {
              void (async () => {
                await api.reviewSendComments(project.path, commentList as ReviewComment[]);
                setComments({});
                setCommentDraft(null);
              })();
            }}
          >
            发送给 agent
          </button>
          <button type="button" className="link" onClick={() => setComments({})}>
            清空
          </button>
        </div>
      )}
      {store.state?.isStreaming && (
        <div className="pane-note">agent 运行中,差异会随其改动实时变化</div>
      )}
    </div>
  );
}
