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
  /** Tool details payload (e.g. edit tool's rendered diff) when available. */
  details?: Record<string, unknown>;
}

export interface Notice {
  id: string;
  kind: "info" | "error";
  text: string;
}

export interface PendingUiRequest {
  id: string;
  kind: "select" | "confirm" | "input" | "editor";
  title: string;
  message?: string;
  options?: string[];
  placeholder?: string;
}

export interface AgentStore {
  status: HostStatus;
  error?: string;
  state: RpcSessionState | null;
  messages: AgentMessage[];
  toolRuns: Record<string, ToolRun>;
  queue: { steering: string[]; followUp: string[] };
  notices: Notice[];
  /** Open extension UI requests (approval cards). */
  pendingUi: PendingUiRequest[];
}

export const emptyAgentStore: AgentStore = {
  status: "stopped",
  state: null,
  messages: [],
  toolRuns: {},
  queue: { steering: [], followUp: [] },
  notices: [],
  pendingUi: [],
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
      upsertRun(next, {
        ...existing,
        status: "done",
        isError: Boolean(event.isError),
        resultText,
        details: result?.details && typeof result.details === "object" ? result.details : undefined,
      });
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

// ---------------------------------------------------------------------------
// Persisted UI prefs (localStorage)
// ---------------------------------------------------------------------------

function atomWithLocalStorage(key: string, initial: boolean) {
  const stored = typeof localStorage !== "undefined" ? localStorage.getItem(key) : null;
  const base = atom<boolean>(stored === null ? initial : stored === "1");
  base.onMount = (setValue) => {
    const listener = (event: StorageEvent): void => {
      if (event.key === key && event.newValue !== null) setValue(event.newValue === "1");
    };
    window.addEventListener("storage", listener);
    return () => window.removeEventListener("storage", listener);
  };
  const wrapped = atom(
    (get) => get(base),
    (_get, set, value: boolean) => {
      set(base, value);
      try {
        localStorage.setItem(key, value ? "1" : "0");
      } catch {
        // Private mode / storage disabled — prefs just won't persist.
      }
    },
  );
  return wrapped;
}

export const leftCollapsedAtom = atomWithLocalStorage("tenon:leftCollapsed", false);
export const rightCollapsedAtom = atomWithLocalStorage("tenon:rightCollapsed", false);

// Right pane tab + review data
export type RightTab = "review" | "files" | "trajectory";
export const rightTabAtom = atom<RightTab>("review");

/** Set to a file path to focus/expand it in the review pane; consumed once. */
export const reviewFocusAtom = atom<string | null>(null);

/** Append-to-composer signal (e.g. @path inserted from the files pane). */
export const composerInsertAtom = atom<{ text: string; nonce: number } | null>(null);

/** Bumped on every agent_settled so panes can refresh turn-scoped data. */
export const agentSettledTickAtom = atom(0);

export const execModeAtom = atom<{ mode: "read-only" | "workspace-write" | "full"; nonce: number }>({
  mode: "workspace-write",
  nonce: 0,
});

// ---------------------------------------------------------------------------
// Theme: "system" follows the OS, otherwise explicit dark/light.
// ---------------------------------------------------------------------------

export type ThemePreference = "system" | "dark" | "light";

function readStoredTheme(): ThemePreference {
  if (typeof localStorage === "undefined") return "system";
  const stored = localStorage.getItem("tenon:theme");
  return stored === "dark" || stored === "light" || stored === "system" ? stored : "system";
}

export const themePreferenceAtom = atom<ThemePreference>(readStoredTheme());

/** Applies the data-theme attribute; call on change and on system flips. */
export function applyTheme(preference: ThemePreference): void {
  const resolved =
    preference === "system"
      ? window.matchMedia("(prefers-color-scheme: light)").matches
        ? "light"
        : "dark"
      : preference;
  document.documentElement.dataset.theme = resolved;
}

export function agentEventToStore(event: TenonEvent, projectPath: string | null, current: AgentStore): AgentStore {
  if (event.kind === "hostStatus") {
    if (!projectPath || event.projectPath !== projectPath) return current;
    return { ...current, status: event.status, error: event.error };
  }
  if (event.kind === "agent") {
    if (!projectPath || event.projectPath !== projectPath) return current;
    return applyAgentEvent(current, event.event);
  }
  if (event.kind === "extensionUi") {
    if (!projectPath || event.projectPath !== projectPath) return current;
    const request = event.request as {
      id: string;
      method: string;
      title?: string;
      message?: string;
      options?: string[];
      placeholder?: string;
      notifyType?: string;
    };
    if (typeof request?.id !== "string") return current;
    // Fire-and-forget notifications surface as transient banners.
    if (request.method === "notify") {
      const kind = request.notifyType === "error" ? "error" : request.notifyType === "warning" ? "error" : "info";
      return { ...current, notices: [...current.notices, { id: request.id, kind, text: request.title ?? "" }] };
    }
    if (request.method === "setStatus" || request.method === "setWidget" || request.method === "setTitle" || request.method === "set_editor_text") {
      return current;
    }
    const kind = request.method as PendingUiRequest["kind"];
    if (kind !== "select" && kind !== "confirm" && kind !== "input" && kind !== "editor") return current;
    return {
      ...current,
      pendingUi: [
        ...current.pendingUi,
        {
          id: request.id,
          kind,
          title: request.title ?? "",
          message: request.message,
          options: request.options,
          placeholder: request.placeholder,
        },
      ],
    };
  }
  return current;
}

export function resolvePendingUi(store: AgentStore, id: string): AgentStore {
  return { ...store, pendingUi: store.pendingUi.filter((request) => request.id !== id) };
}
