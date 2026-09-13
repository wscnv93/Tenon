import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { agentStoreAtom } from "../state";
import type { AgentMessage, AssistantMessage, ToolCall, UserMessage } from "@protocol/pi-types";
import { Markdown } from "./Markdown";
import { RawDiff } from "./DiffView";
import { TIcon } from "./TIcon";

interface TurnView {
  user: UserMessage | null;
  assistants: AssistantMessage[];
  streaming: boolean;
}

function textOfMessage(message: AssistantMessage): string {
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => (block as { text: string }).text)
    .join("");
}

function groupTurns(messages: AgentMessage[], isStreaming: boolean): TurnView[] {
  const turns: TurnView[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      turns.push({ user: message as UserMessage, assistants: [], streaming: false });
    } else if (message.role === "assistant" && turns.length > 0) {
      turns.at(-1)!.assistants.push(message as AssistantMessage);
    }
  }
  if (isStreaming && turns.length > 0) turns.at(-1)!.streaming = true;
  return turns;
}

function UserBubble({ message }: { message: UserMessage }) {
  return (
    <div className="msg-user">
      <div className="msg-user-text">
        {typeof message.content === "string" ? (
          message.content
        ) : (
          message.content
            .filter((block) => block.type === "text")
            .map((block, i) => <span key={i}>{(block as { text: string }).text}</span>)
        )}
      </div>
    </div>
  );
}

function argsPreview(args: Record<string, unknown>): string {
  const entries = Object.entries(args).filter(([key]) => key !== "__partial");
  if (entries.length === 0) return "";
  const first = entries[0]!;
  const value = typeof first[1] === "string" ? first[1] : JSON.stringify(first[1]);
  const truncated = value.length > 80 ? value.slice(0, 80) + "…" : value;
  return `${first[0]}: ${truncated}`;
}

function ToolRunCard({ call }: { call: ToolCall }) {
  const store = useAtomValue(agentStoreAtom);
  const [open, setOpen] = useState(false);
  const run = store.toolRuns[call.id];
  const name = call.name || run?.toolName || "tool";
  const status = run?.status ?? "running";
  const isError = run?.isError ?? false;
  const output = run?.resultText ?? run?.partialText ?? "";
  const summary = argsPreview((call.arguments ?? {}) as Record<string, unknown>);

  return (
    <div className={`tool-card ${status === "running" ? "tool-running" : isError ? "tool-error" : "tool-done"}`}>
      <button type="button" className="tool-card-header" onClick={() => setOpen(!open)}>
        <span className={`tool-status-dot tool-status-${status === "running" ? "running" : isError ? "error" : "done"}`} />
        <span className="tool-name">{name}</span>
        {summary && <span className="tool-summary">{summary}</span>}
        <span className="tool-caret">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="tool-card-body">
          {Object.keys(call.arguments ?? {}).filter((key) => key !== "__partial").length > 0 && (
            <details className="tool-args">
              <summary>参数</summary>
              <pre>{JSON.stringify(Object.fromEntries(Object.entries(call.arguments).filter(([key]) => key !== "__partial")), null, 2)}</pre>
            </details>
          )}
          {typeof run?.details?.diff === "string" ? (
            <RawDiff text={run.details.diff} />
          ) : (
            output && <pre className="tool-output">{output.slice(0, 20000)}</pre>
          )}
          {status === "running" && !output && <div className="tool-output tool-output-empty">运行中…</div>}
        </div>
      )}
    </div>
  );
}

function ThinkingBlock({ text, streaming }: { text: string; streaming: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="thinking-block">
      <button type="button" className="thinking-header" onClick={() => setOpen(!open)}>
        <span className={`thinking-icon ${streaming ? "thinking-live" : ""}`}>◈</span>
        <span>{streaming ? "思考中…" : "思考过程"}</span>
        <span className="tool-caret">{open ? "▾" : "▸"}</span>
      </button>
      {open && <div className="thinking-body">{text}</div>}
    </div>
  );
}

/** Collapsible container for one assistant message's intermediate content. */
function ProcessGroup({
  message,
  streaming,
  open,
  onToggle,
}: {
  message: AssistantMessage;
  streaming: boolean;
  open: boolean;
  onToggle: (open: boolean) => void;
}) {
  const toolCount = message.content.filter((block) => block.type === "toolCall").length;
  const hasThinking = message.content.some((block) => block.type === "thinking");
  const text = textOfMessage(message);
  const header = toolCount > 0 ? `中间过程 · ${toolCount} 次工具调用` : hasThinking ? "思考与过程" : "过程";

  return (
    <div className={`process-group ${streaming ? "process-live" : ""}`}>
      <button
        type="button"
        className="process-header"
        onClick={() => onToggle(!open)}
      >
        <span className={`tool-status-dot ${streaming ? "tool-status-running" : "tool-status-done"}`} />
        <span>{streaming ? "执行中…" : header}</span>
        {!open && text && <span className="process-peek">{text.slice(0, 60)}</span>}
        <span className="tool-caret">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="process-body">
          {message.content.map((block, i) => {
            if (block.type === "thinking") {
              return <ThinkingBlock key={i} text={block.thinking} streaming={streaming} />;
            }
            if (block.type === "toolCall") {
              return <ToolRunCard key={block.id || i} call={block} />;
            }
            return (
              <div key={i} className="process-text">
                <Markdown text={block.text} />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function FinalBody({ message, streaming }: { message: AssistantMessage; streaming: boolean }) {
  const hasText = message.content.some((block) => block.type === "text" && (block as { text: string }).text.trim().length > 0);
  const usage = message.usage;
  return (
    <div className="msg-assistant">
      {message.content.map((block, i) =>
        block.type === "toolCall" ? <ToolRunCard key={block.id || i} call={block} /> : null,
      )}
      {hasText ? (
        message.content.map((block, i) =>
          block.type === "text" ? <Markdown key={`t${i}`} text={block.text} /> : null,
        )
      ) : (
        <div className="thread-pending">{streaming ? "正在生成…" : "(本轮无文本输出)"}</div>
      )}
      {streaming && hasText && <span className="stream-cursor" />}
      {!streaming && usage && (
        <div className="msg-usage">
          {usage.totalTokens.toLocaleString()} tokens ·{" "}
          {usage.cost.total >= 0.01 ? `$${usage.cost.total.toFixed(2)}` : `${(usage.cost.total * 100).toFixed(1)}¢`} ·{" "}
          {message.provider}/{message.model}
        </div>
      )}
      {message.stopReason === "error" && message.errorMessage && (
        <div className="msg-error">模型错误:{message.errorMessage}</div>
      )}
    </div>
  );
}

export function ThreadView() {
  const [store] = useAtom(agentStoreAtom);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  /** Manual per-turn override for the process group (keyed by turn index). */
  const [processOpen, setProcessOpen] = useState<Record<number, boolean>>({});

  const streaming = store.state?.isStreaming ?? false;
  const turns = useMemo(() => groupTurns(store.messages, streaming), [store.messages, streaming]);
  const liveTurnIndex = streaming ? turns.findIndex((turn) => turn.streaming) : -1;

  // Auto-open the running turn's process group; auto-collapse when settled.
  const prevLiveRef = useRef(-1);
  useEffect(() => {
    if (liveTurnIndex >= 0) {
      setProcessOpen((prev) => ({ ...prev, [liveTurnIndex]: true }));
    } else if (prevLiveRef.current >= 0) {
      const settled = prevLiveRef.current;
      setProcessOpen((prev) => {
        if (!(settled in prev)) return prev;
        const next = { ...prev };
        delete next[settled];
        return next;
      });
    }
    prevLiveRef.current = liveTurnIndex;
  }, [liveTurnIndex]);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element && pinnedRef.current) {
      element.scrollTop = element.scrollHeight;
    }
  }, [store.messages, store.toolRuns, store.notices]);

  const onScroll = (): void => {
    const element = scrollRef.current;
    if (!element) return;
    pinnedRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 120;
  };

  useEffect(() => {
    pinnedRef.current = true;
  }, [store.state?.sessionFile]);

  if (!store.state && store.status !== "error") {
    return (
      <div className="thread-empty" ref={scrollRef}>
        <div className="thread-empty-hero">
          <span className="badge">
            <TIcon size={26} />
          </span>
          <h2>Tenon 已就绪</h2>
          <p>在下方描述任务;配置厂商密钥后模型会自动出现。</p>
        </div>
      </div>
    );
  }

  return (
    <div className="thread" ref={scrollRef} onScroll={onScroll}>
      {store.status === "error" && (
        <div className="banner banner-error">引擎进程异常:{store.error ?? "未知错误"}</div>
      )}
      {store.notices.map((notice) => (
        <div key={notice.id} className={`banner ${notice.kind === "error" ? "banner-error" : "banner-info"}`}>
          {notice.text}
        </div>
      ))}

      {turns.map((turn, turnIndex) => {
        const isLive = turn.streaming;
        const groupOpen = processOpen[turnIndex] ?? false;
        // The turn's body: the last assistant message carrying text; while
        // streaming with no text yet, the running message previews as pending.
        let bodyIndex = -1;
        for (let i = turn.assistants.length - 1; i >= 0; i--) {
          if (textOfMessage(turn.assistants[i]!).trim().length > 0) {
            bodyIndex = i;
            break;
          }
        }
        if (bodyIndex === -1 && isLive && turn.assistants.length > 0) {
          bodyIndex = turn.assistants.length - 1;
        }
        return (
          <div key={turnIndex} className="turn">
            {turn.user && <UserBubble message={turn.user} />}
            {turn.assistants.map((assistant, i) => {
              if (i === bodyIndex) {
                return <FinalBody key={i} message={assistant} streaming={isLive && i === turn.assistants.length - 1} />;
              }
              return (
                <ProcessGroup
                  key={i}
                  message={assistant}
                  streaming={isLive && i === turn.assistants.length - 1}
                  open={groupOpen}
                  onToggle={(value) => setProcessOpen((prev) => ({ ...prev, [turnIndex]: value }))}
                />
              );
            })}
          </div>
        );
      })}

      {streaming && turns.length === 0 && <div className="thread-pending">正在等待模型响应…</div>}

      {(store.queue.steering.length > 0 || store.queue.followUp.length > 0) && (
        <div className="queue-row">
          {store.queue.followUp.map((text, i) => (
            <span key={`f${i}`} className="queue-pill">后续:{text.slice(0, 40)}</span>
          ))}
          {store.queue.steering.map((text, i) => (
            <span key={`s${i}`} className="queue-pill queue-pill-steer">插话:{text.slice(0, 40)}</span>
          ))}
        </div>
      )}
    </div>
  );
}
