import { useState } from "react";
import { useAtom, useAtomValue } from "jotai";
import { api } from "../lib/api";
import { activeProjectAtom, agentStoreAtom, resolvePendingUi } from "../state";
import type { PendingUiRequest } from "../state";

function respond(projectPath: string, request: PendingUiRequest, payload: Record<string, unknown>): void {
  void api.extensionUiResponse(projectPath, request.id, payload);
}

export function ApprovalCards() {
  const project = useAtomValue(activeProjectAtom);
  const [store, setStore] = useAtom(agentStoreAtom);
  const [draft, setDraft] = useState("");

  if (!project || store.pendingUi.length === 0) return null;

  const answer = (request: PendingUiRequest, payload: Record<string, unknown>): void => {
    respond(project.path, request, payload);
    setStore((current) => resolvePendingUi(current, request.id));
    setDraft("");
  };

  return (
    <div className="approval-stack">
      {store.pendingUi.map((request) => (
        <div key={request.id} className="approval-card">
          <div className="approval-head">
            <span className="approval-shield">◇</span>
            <span className="approval-title">需要批准</span>
          </div>
          <pre className="approval-body">{request.title}</pre>
          {request.message && <pre className="approval-body approval-message">{request.message}</pre>}

          {request.kind === "select" && request.options && (
            <div className="approval-actions">
              {request.options.map((option) => (
                <button
                  key={option}
                  type="button"
                  className={`btn btn-small ${option.includes("拒绝") || option.includes("否") ? "btn-stop" : "btn-send"}`}
                  onClick={() => answer(request, { value: option })}
                >
                  {option}
                </button>
              ))}
            </div>
          )}

          {request.kind === "confirm" && (
            <div className="approval-actions">
              <button type="button" className="btn btn-small btn-send" onClick={() => answer(request, { confirmed: true })}>
                批准
              </button>
              <button type="button" className="btn btn-small btn-stop" onClick={() => answer(request, { confirmed: false })}>
                拒绝
              </button>
            </div>
          )}

          {(request.kind === "input" || request.kind === "editor") && (
            <div className="approval-input">
              <input
                autoFocus
                value={draft}
                placeholder={request.placeholder ?? "输入内容"}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.nativeEvent.isComposing) answer(request, { value: draft });
                }}
              />
              <button type="button" className="btn btn-small btn-send" onClick={() => answer(request, { value: draft })}>
                确定
              </button>
              <button type="button" className="btn btn-small" onClick={() => answer(request, { cancelled: true })}>
                取消
              </button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
