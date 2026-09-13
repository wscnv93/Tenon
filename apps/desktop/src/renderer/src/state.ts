import { atom } from "jotai";
import type {
  AgentMessage,
  AssistantMessage,
  ImageContent,
  JsonAgentSessionEvent,
  Model,
  RpcSessionState,
  TextContent,
  ThinkingContent,
  ToolCall,
} from "@protocol/pi-types";
import type { AppInfo, HostStatus, ProviderCredentialStatus, SessionSummary, TenonEvent, TenonProject } from "@protocol/ipc";

// ---------------------------------------------------------------------------
// Transcript view model
// ---------------------------------------------------------------------------

export interface ToolRun {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  status: "running" | "done";
  isError: boolean;
  /** Accumulated partial result content (text), for live output. */
  partialText: string;
  resultText: string | null;
}

export interface Notice {
  id: string;
  kind: "info" | "error";
  text: string;
}

export interface AgentStore {
  status: HostStatus;
  error?: string;
  state: RpcSessionState | null;
  messages: AgentMessage[];
  toolRuns: Record<string, ToolRun>;
  queue: { steering: string[]; followUp: string[] };
  notices: Notice[];
}

export const emptyAgentStore: AgentStore = {
  status: "stopped",
  state: null,
  messages: [],
  toolRuns: {},
  queue: { steering: [], followUp: [] },
  notices: [],
};

let noticeSeq = 0;

function lastAssistant(messages: AgentMessage[]): AssistantMessage | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role === "assistant") return message;
    if (message.role === "user" || message.role === "toolResult") continue;
  }
  return null;
}

function upsertRun(store: AgentStore, run: ToolRun): void {
  store.toolRuns = { ...store.toolRuns, [run.toolCallId]: run };
}

/** Apply a streaming pi event to the agent store (pure: returns a new store). */
export function applyAgentEvent(store: AgentStore, event: JsonAgentSessionEvent): AgentStore {
  const next: AgentStore = { ...store };
  switch (event.type) {
    case "agent_start":
      next.notices = store.notices;
      return next;
    case "agent_end":
      return next;
    case "agent_settled":
      return next;
    case "turn_start":
      return next;
    case "turn_end":
      return next;
    case "message_start": {
      const message = event.message as AgentMessage;
      if (message.role === "user" || message.role === "assistant" || message.role === "toolResult") {
        next.messages = [...store.messages, message];
      }
      return next;
    }
    case "message_update": {
      const assistant = lastAssistant(store.messages);
      if (!assistant) return store;
      const delta = event.assistantMessageEvent as any;
      const content = assistant.content.slice();
      const index = typeof delta.contentIndex === "number" ? delta.contentIndex : content.length - 1;
      const applyTo = (block: TextContent | ThinkingContent | ToolCall): void => {
        content[index] = block;
      };
      switch (delta.type) {
        case "text_start":
          applyTo({ type: "text", text: "" });
          break;
        case "text_delta":
          applyTo({ type: "text", text: ((content[index] as TextContent | undefined)?.type === "text" ? (content[index] as TextContent).text : "") + (delta.delta ?? "") });
          break;
        case "thinking_start":
          applyTo({ type: "thinking", thinking: "" });
          break;
        case "thinking_delta":
          applyTo({ type: "thinking", thinking: ((content[index] as ThinkingContent | undefined)?.type === "thinking" ? (content[index] as ThinkingContent).thinking : "") + (delta.delta ?? "") });
          break;
        case "toolcall_start":
          applyTo({ type: "toolCall", id: delta.id ?? "", name: delta.toolName ?? "", arguments: {} });
          break;
        case "toolcall_delta": {
          // Partial JSON argument text; toolcall_end carries the full call.
          const existing = content[index] as ToolCall | undefined;
          if (existing?.type === "toolCall") {
            applyTo({ ...existing, arguments: { ...existing.arguments, __partial: ((existing.arguments as any).__partial ?? "") + (delta.delta ?? "") } });
          }
          break;
        }
        case "toolcall_end": {
          const full = delta.toolCall as ToolCall | undefined;
          if (full) applyTo(full);
          break;
        }
        default:
          break;
      }
      const updated: AssistantMessage = { ...assistant, content };
      if (event.usage) updated.usage = event.usage;
      // The assistant we patched is the last assistant (and last message) in the list.
      next.messages = store.messages.map((message, i) => {
        if (i !== store.messages.length - 1) return message;
        return message.role === "assistant" ? updated : message;
      });
      return next;
    }
    case "message_end": {
      const message = event.message as AgentMessage;
      const messages = store.messages.slice();
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]!.role === message.role) {
          messages[i] = message;
          break;
        }
      }
      next.messages = messages;
      if (message.role === "assistant") {
        // Seed tool run entries from the authoritative message.
        const runs = { ...store.toolRuns };
        for (const block of message.content) {
          if (block.type === "toolCall" && !runs[block.id]) {
            runs[block.id] = {
              toolCallId: block.id,
              toolName: block.name,
              args: block.arguments as Record<string, unknown>,
              status: "running",
              isError: false,
              partialText: "",
              resultText: null,
            };
          }
        }
        next.toolRuns = runs;
      }
      return next;
    }
    case "tool_execution_start": {
      upsertRun(next, {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: (event.args ?? {}) as Record<string, unknown>,
        status: "running",
        isError: false,
        partialText: "",
        resultText: null,
      });
      return next;
    }
    case "tool_execution_update": {
      const existing = store.toolRuns[event.toolCallId];
      if (!existing) return store;
      const partial = event.partialResult;
      const partialText = Array.isArray(partial?.content)
        ? partial.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n")
        : "";
      upsertRun(next, { ...existing, partialText });
      return next;
    }
    case "tool_execution_end": {
      const existing = store.toolRuns[event.toolCallId] ?? {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: {},
        status: "running" as const,
        isError: false,
        partialText: "",
        resultText: null,
      };
      const result = event.result as any;
      const resultText = Array.isArray(result?.content)
        ? result.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n")
        : "";
      upsertRun(next, { ...existing, status: "done", isError: Boolean(event.isError), resultText });
      return next;
    }
    case "queue_update":
      next.queue = { steering: [...(event.steering ?? [])], followUp: [...(event.followUp ?? [])] };
      return next;
    case "compaction_start":
      next.notices = [...store.notices, { id: `n${noticeSeq++}`, kind: "info", text: "正在压缩上下文…" }];
      return next;
    case "compaction_end":
      next.notices = store.notices.filter((notice) => notice.text !== "正在压缩上下文…");
      return next;
    case "auto_retry_start":
      next.notices = [
        ...store.notices,
        { id: `n${noticeSeq++}`, kind: "error", text: `请求失败,自动重试 ${event.attempt}/${event.maxAttempts}…` },
      ];
      return next;
    case "auto_retry_end":
      next.notices = store.notices.filter((notice) => !notice.text.includes("自动重试"));
      if (!event.success && event.finalError) {
        next.notices = [...next.notices, { id: `n${noticeSeq++}`, kind: "error", text: `请求失败:${event.finalError}` }];
      }
      return next;
    default:
      return store;
  }
}

// ---------------------------------------------------------------------------
// Atoms
// ---------------------------------------------------------------------------

export const appInfoAtom = atom<AppInfo | null>(null);
export const projectsAtom = atom<TenonProject[]>([]);
export const activeProjectIdAtom = atom<string | null>(null);
export const activeProjectAtom = atom((get) => {
  const projects = get(projectsAtom);
  const activeId = get(activeProjectIdAtom);
  return projects.find((project) => project.id === activeId) ?? null;
});
export const sessionsAtom = atom<SessionSummary[]>([]);
export const modelsAtom = atom<Model<any>[]>([]);
export const modelsLoadingAtom = atom(false);
export const authStatusAtom = atom<ProviderCredentialStatus[]>([]);
export const agentStoreAtom = atom<AgentStore>(emptyAgentStore);
export const settingsOpenAtom = atom(false);
export const thinkingLevelsAtom = atom<string[]>(["off", "low", "medium", "high"]);

export function agentEventToStore(event: TenonEvent, projectPath: string | null, current: AgentStore): AgentStore {
  if (event.kind === "hostStatus") {
    if (!projectPath || event.projectPath !== projectPath) return current;
    return { ...current, status: event.status, error: event.error };
  }
  if (event.kind === "agent") {
    if (!projectPath || event.projectPath !== projectPath) return current;
    return applyAgentEvent(current, event.event);
  }
  return current;
}
