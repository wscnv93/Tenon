import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useAtom, useAtomValue } from "jotai";
import { agentStoreAtom } from "../state";
import type { AgentMessage, AssistantMessage, ToolCall } from "@protocol/pi-types";
import { Markdown } from "./Markdown";

function textOf(content: string | Array<{ type: string; text?: string }>): string {
  if (typeof content === "string") return content;
  return content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("");
}

function UserBubble({ message }: { message: Extract<AgentMessage, { role: "user" }> }) {
  return (
    <div className="msg-user">
      <div className="msg-user-avatar">你</div>
      <div className="msg-user-body">
        {typeof message.content === "string" ? (
          <div className="msg-user-text">{message.content}</div>
        ) : (
          message.content.map((block, i) =>
            block.type === "text" ? (
              <div key={i} className="msg-user-text">{block.text}</div>
            ) : null,
          )
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
          {output && <pre className="tool-output">{output.slice(0, 20000)}</pre>}
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

function AssistantBlock({ message, streaming }: { message: AssistantMessage; streaming: boolean }) {
  const hasText = message.content.some((block) => block.type === "text" && block.text.trim().length > 0);
  const usage = message.usage;
  return (
    <div className="msg-assistant">
      {message.content.map((block, i) => {
        if (block.type === "thinking") {
          return <ThinkingBlock key={i} text={block.thinking} streaming={streaming && !hasText} />;
        }
        if (block.type === "toolCall") {
          return <ToolRunCard key={block.id || i} call={block} />;
        }
        return <Markdown key={i} text={block.text} />;
      })}
      {message.stopReason === "error" && message.errorMessage && (
        <div className="msg-error">模型错误:{message.errorMessage}</div>
      )}
      {!streaming && usage && (
        <div className="msg-usage">
          {usage.totalTokens.toLocaleString()} tokens · {usage.cost.total >= 0.01
            ? `$${usage.cost.total.toFixed(2)}`
            : `${(usage.cost.total * 100).toFixed(1)}¢`}{" "}
          · {message.provider}/{message.model}
        </div>
      )}
      {streaming && hasText && <span className="stream-cursor" />}
    </div>
  );
}

export function ThreadView() {
  const [store] = useAtom(agentStoreAtom);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);

  const streaming = store.state?.isStreaming ?? false;

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
          <div className="thread-empty-logo">桥</div>
          <h2>Tenon</h2>
          <p>打开一个代码仓库,配置任意厂商的 API Key,即可开始。</p>
        </div>
      </div>
    );
  }

  return (
    <div className="thread" ref={scrollRef} onScroll={onScroll}>
      {store.status === "error" && (
        <div className="banner banner-error">
          引擎进程异常:{store.error ?? "未知错误"}
        </div>
      )}
      {store.notices.map((notice) => (
        <div key={notice.id} className={`banner ${notice.kind === "error" ? "banner-error" : "banner-info"}`}>
          {notice.text}
        </div>
      ))}
      {store.messages.map((message, i) => {
        if (message.role === "user") return <UserBubble key={i} message={message} />;
        if (message.role === "assistant") {
          const isLastAssistant = store.messages.slice(i + 1).every((m) => m.role === "toolResult");
          return <AssistantBlock key={i} message={message} streaming={streaming && isLastAssistant} />;
        }
        return null;
      })}
      {streaming && !store.messages.some((m) => m.role === "assistant") && (
        <div className="thread-pending">正在等待模型响应…</div>
      )}
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
