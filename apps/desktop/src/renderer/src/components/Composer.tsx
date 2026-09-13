import { useEffect, useMemo, useRef, useState } from "react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { api } from "../lib/api";
import {
  activeProjectAtom,
  agentStoreAtom,
  authStatusAtom,
  composerInsertAtom,
  execModeAtom,
  modelsAtom,
  modelsLoadingAtom,
  settingsOpenAtom,
  thinkingLevelsAtom,
} from "../state";
import { EXEC_MODE_LABEL } from "@protocol/ipc";
import type { ExecMode } from "@protocol/ipc";
import type { Model } from "@protocol/pi-types";

function ModelPicker({ onPicked }: { onPicked: () => void }) {
  const project = useAtomValue(activeProjectAtom);
  const store = useAtomValue(agentStoreAtom);
  const setAgentStore = useSetAtom(agentStoreAtom);
  const [models, setModels] = useAtom(modelsAtom);
  const [, setLoading] = useAtom(modelsLoadingAtom);
  const setLevels = useSetAtom(thinkingLevelsAtom);
  const setSettingsOpen = useSetAtom(settingsOpenAtom);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [loadingNow, setLoadingNow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDocClick = (event: MouseEvent): void => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  const refresh = async (): Promise<void> => {
    if (!project) return;
    setLoadingNow(true);
    setLoading(true);
    setError(null);
    try {
      const result = await api.agentGetModels(project.path);
      setModels(result.models);
      if (result.models.length === 0) {
        setError("没有可用模型 — 请先在设置中保存厂商 API Key");
      }
    } catch (err) {
      setError(`拉取模型失败:${String(err instanceof Error ? err.message : err)}`);
    } finally {
      setLoadingNow(false);
      setLoading(false);
    }
  };

  const pick = async (model: Model<any>): Promise<void> => {
    if (!project) return;
    setError(null);
    try {
      const result = await api.agentSetModel(project.path, model.provider, model.id);
      setAgentStore((current) => ({ ...current, state: result.state }));
      const levels = await api.agentGetThinkingLevels(project.path);
      setLevels(levels.levels.map(String));
      setOpen(false);
      onPicked();
    } catch (err) {
      setError(`切换模型失败:${String(err instanceof Error ? err.message : err)}`);
    }
  };

  const groups = useMemo(() => {
    const filtered = models.filter((model) => {
      if (!query) return true;
      const q = query.toLowerCase();
      return (
        model.name.toLowerCase().includes(q) ||
        model.id.toLowerCase().includes(q) ||
        model.provider.toLowerCase().includes(q)
      );
    });
    const byProvider = new Map<string, Model<any>[]>();
    for (const model of filtered) {
      const list = byProvider.get(model.provider) ?? [];
      list.push(model);
      byProvider.set(model.provider, list);
    }
    return [...byProvider.entries()];
  }, [models, query]);

  if (!project) return null;

  const current = store.state?.model as Model<any> | undefined;
  const currentKey = current ? `${current.provider}/${current.id}` : null;
  const label = (() => {
    if (loadingNow) return "加载模型…";
    const match = currentKey ? models.find((m) => `${m.provider}/${m.id}` === currentKey) : undefined;
    if (match) return match.name || match.id;
    if (current) return current.name || `${current.provider}/${current.id}`;
    return "选择模型";
  })();

  return (
    <div className="model-picker" ref={wrapRef}>
      <button
        type="button"
        className="chip chip-model"
        onClick={() => {
          if (!open) void refresh();
          setOpen(!open);
        }}
      >
        <span className="chip-dot" />
        {label}
      </button>
      {open && (
        <div className="popover">
          <div className="popover-search">
            <input autoFocus value={query} placeholder="搜索厂商或模型…" onChange={(event) => setQuery(event.target.value)} />
          </div>
          <div className="popover-list">
            {error && <div className="popover-empty popover-error">{error}</div>}
            {!error && groups.length === 0 && (
              <div className="popover-empty">
                {loadingNow ? "正在拉取模型列表…" : "没有可用模型。请先在设置中配置厂商 API Key。"}
              </div>
            )}
            {groups.map(([provider, list]) => (
              <div key={provider}>
                <div className="popover-group">{provider}</div>
                {list.map((model) => {
                  const key = `${model.provider}/${model.id}`;
                  return (
                    <button
                      key={key}
                      type="button"
                      className={`popover-item ${key === currentKey ? "popover-item-active" : ""}`}
                      onClick={() => void pick(model)}
                    >
                      <span className="popover-item-name">{model.name || model.id}</span>
                      <span className="popover-item-meta">
                        {model.reasoning ? "推理 · " : ""}
                        {Math.round(model.contextWindow / 1000)}k
                      </span>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
          <button type="button" className="popover-footer" onClick={() => setSettingsOpen(true)}>
            管理厂商与 API Key…
          </button>
        </div>
      )}
    </div>
  );
}

export function Composer() {
  const project = useAtomValue(activeProjectAtom);
  const [store] = useAtom(agentStoreAtom);
  const setAgentStore = useSetAtom(agentStoreAtom);
  const auth = useAtomValue(authStatusAtom);
  const [levels] = useAtom(thinkingLevelsAtom);
  const setSettingsOpen = useSetAtom(settingsOpenAtom);
  const [text, setText] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const insertSignal = useAtomValue(composerInsertAtom);
  const [execMode, setExecMode] = useAtom(execModeAtom);

  // Files pane "insert @path" requests.
  useEffect(() => {
    if (!insertSignal) return;
    setText((prev) => prev + insertSignal.text);
    textareaRef.current?.focus();
  }, [insertSignal]);

  // Load the persisted execution mode once.
  useEffect(() => {
    void api.getExecMode().then((result) => {
      setExecMode({ mode: result.mode, nonce: Date.now() });
    });
  }, [setExecMode]);

  const MODE_CYCLE: ExecMode[] = ["read-only", "workspace-write", "full"];
  const cycleMode = (): void => {
    const next = MODE_CYCLE[(MODE_CYCLE.indexOf(execMode.mode) + 1) % MODE_CYCLE.length]!;
    setExecMode({ mode: next, nonce: Date.now() });
    void api.setExecMode(next);
  };

  const streaming = store.state?.isStreaming ?? false;
  const noKeys = auth.length > 0 && auth.every((entry) => !entry.configured);

  const send = async (): Promise<void> => {
    const message = text.trim();
    if (!message || !project || streaming) return;
    try {
      setText("");
      if (textareaRef.current) textareaRef.current.style.height = "auto";
      await api.agentPrompt(project.path, message);
    } catch (error) {
      // Restore the draft and surface the failure instead of silently dropping it.
      setText(message);
      setAgentStore((current) => ({
        ...current,
        notices: [
          ...current.notices,
          { id: `err${Date.now()}`, kind: "error", text: `发送失败:${error instanceof Error ? error.message : String(error)}` },
        ],
      }));
    }
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
      return;
    }
    // Shift+Tab cycles the execution mode (Codex/ZCode convention).
    if (event.key === "Tab" && event.shiftKey) {
      event.preventDefault();
      cycleMode();
    }
  };

  const autoGrow = (element: HTMLTextAreaElement): void => {
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 320)}px`;
  };

  const setThinking = async (level: string): Promise<void> => {
    if (!project) return;
    await api.agentSetThinking(project.path, level);
  };

  return (
    <div className="composer">
      {noKeys && (
        <div className="composer-hint">
          还没有配置任何厂商密钥。
          <button type="button" className="link" onClick={() => setSettingsOpen(true)}>
            打开设置配置 API Key
          </button>
        </div>
      )}
      <div className="composer-box">
        <textarea
          ref={textareaRef}
          value={text}
          rows={1}
          placeholder={streaming ? "运行中…可输入内容加入队列" : "描述任务,Enter 发送,Shift+Enter 换行"}
          onChange={(event) => {
            setText(event.target.value);
            autoGrow(event.target);
          }}
          onKeyDown={onKeyDown}
        />
        <div className="composer-actions">
          <ModelPicker onPicked={() => textareaRef.current?.focus()} />
          <button
            type="button"
            className={`chip chip-mode mode-${execMode.mode}`}
            title="执行模式(Shift+Tab 切换)"
            onClick={cycleMode}
          >
            {EXEC_MODE_LABEL[execMode.mode]}
          </button>
          <select
            className="chip chip-select"
            value={store.state?.thinkingLevel ?? "low"}
            onChange={(event) => void setThinking(event.target.value)}
          >
            {levels.map((level) => (
              <option key={level} value={level}>
                思考:{level}
              </option>
            ))}
          </select>
          <div className="composer-spacer" />
          {streaming ? (
            <button
              type="button"
              className="btn btn-stop"
              onClick={() => project && void api.agentAbort(project.path)}
            >
              停止
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-send"
              disabled={!text.trim()}
              onClick={() => void send()}
            >
              发送
            </button>
          )}
        </div>
      </div>
      <div className="composer-meta">
        {store.state?.sessionFile ? `会话 ${store.state.sessionFile.split("/").pop()?.slice(0, 24)}…` : "新会话"}
      </div>
    </div>
  );
}
