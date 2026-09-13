import { useCallback, useEffect, useMemo, useState } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { buildTrajectory, type TrajStep, type TrajTurn } from "@protocol/trajectory";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { api } from "../lib/api";
import { activeProjectAtom, agentSettledTickAtom, agentStoreAtom } from "../state";

const STEP_ICON: Record<TrajStep["kind"], string> = {
  user: "◆",
  assistant: "◇",
  toolResult: "⚙",
  compaction: "⟲",
  model_change: "⟳",
  thinking_level: "≡",
  other: "·",
};

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  return `${Math.floor(seconds / 60)}m${Math.round(seconds % 60)}s`;
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toTimeString().slice(0, 8);
}

export function TrajectoryPane() {
  const project = useAtomValue(activeProjectAtom);
  const settledTick = useAtomValue(agentSettledTickAtom);
  const store = useAtomValue(agentStoreAtom);
  const [view, setView] = useState<ReturnType<typeof buildTrajectory> | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    if (!project) return;
    try {
      const result = await api.getEntries(project.path);
      const built = buildTrajectory(result.entries as SessionEntry[], result.leafId);
      setView(built);
      setSelectedId((prev) => (prev && built.turns.some((turn) => turn.id === prev) ? prev : (built.turns.at(-1)?.id ?? null)));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [project]);

  useEffect(() => {
    void load();
  }, [load, settledTick, store.state?.sessionFile]);

  const selected = useMemo(() => view?.turns.find((turn) => turn.id === selectedId) ?? null, [view, selectedId]);

  const fork = async (entryId: string): Promise<void> => {
    if (!project || busy) return;
    setBusy(true);
    try {
      await api.agentForkAt(project.path, entryId);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (!project) return <div className="pane-empty">未选择项目</div>;

  const maxDuration = Math.max(1000, ...(view?.turns.map((turn) => turn.durationMs) ?? []));

  return (
    <div className="traj-pane">
      <div className="review-toolbar">
        <span className="review-totals">
          {view ? `${view.totals.turns} 轮 · ${view.totals.tokens.toLocaleString()} tokens · $${view.totals.cost.toFixed(3)}` + (view.totals.abandoned > 0 ? ` · ${view.totals.abandoned} 轮废弃分支` : "") : ""}
        </span>
        <button type="button" className="icon-btn" title="刷新" onClick={() => void load()}>
          ⟳
        </button>
      </div>

      {error && <div className="pane-note pane-note-error">{error}</div>}

      {view && view.turns.length === 0 && <div className="pane-empty">还没有可回溯的轨迹 — 发送第一条消息后这里会出现完整时间线</div>}

      {view && view.turns.length > 0 && (
        <>
          <div className="traj-timeline">
            {view.turns.map((turn) => (
              <button
                key={turn.id}
                type="button"
                className={`traj-seg ${turn.id === selectedId ? "on" : ""} ${turn.active ? "" : "abandoned"}`}
                style={{ flexGrow: Math.max(0.6, turn.durationMs / maxDuration) }}
                title={`${turn.label.slice(0, 60)}\n${formatTime(turn.startTs)} · ${formatDuration(turn.durationMs)} · ${turn.tokens.toLocaleString()} tk`}
                onClick={() => setSelectedId(turn.id)}
              >
                <span className="traj-seg-fill" />
              </button>
            ))}
          </div>

          {selected && (
            <div className="traj-inspector">
              <div className="traj-turn-head">
                <span className={`traj-turn-flag ${selected.active ? "" : "abandoned"}`}>
                  {selected.active ? "当前路径" : "废弃分支"}
                </span>
                <span className="traj-turn-meta mono">
                  {formatTime(selected.startTs)} · {formatDuration(selected.durationMs)} ·{" "}
                  {selected.tokens.toLocaleString()} tk · {selected.toolCalls} 次工具
                </span>
              </div>
              <div className="traj-turn-label">{selected.label}</div>
              <div className="traj-steps">
                {selected.steps.map((step) => (
                  <div key={step.entryId} className={`traj-step ${step.isError ? "traj-step-error" : ""}`}>
                    <span className={`traj-step-icon k-${step.kind}`}>{STEP_ICON[step.kind]}</span>
                    <span className="traj-step-label">{step.label.slice(0, 160) || "(空)"}</span>
                    <span className="traj-step-meta mono">
                      {formatTime(step.ts)}
                      {step.tokens !== undefined ? ` · ${step.tokens.toLocaleString()} tk` : ""}
                      {step.cost !== undefined ? ` · $${step.cost.toFixed(4)}` : ""}
                    </span>
                    {step.kind === "user" && (
                      <button
                        type="button"
                        className="link"
                        disabled={busy}
                        title="从此处分叉续跑"
                        onClick={() => void fork(step.entryId)}
                      >
                        ⑂ 分叉
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
