/**
 * Tenon main ⇄ renderer IPC contract.
 *
 * - `invoke` channels are registered with ipcMain.handle and called from the
 *   renderer through the preload bridge.
 * - `TENON_EVENT_CHANNEL` is the single push channel (main → renderer).
 *
 * This module must stay importable from both the main process and the
 * renderer bundle: it contains only constants and types — no node builtins.
 */
import type { AgentMessage, JsonAgentSessionEvent, Model, RpcSessionState, ThinkingLevel } from "./pi-types.js";

export const TENON_EVENT_CHANNEL = "tenon:event";

// ---------------------------------------------------------------------------
// App info
// ---------------------------------------------------------------------------

export interface AppInfo {
  appVersion: string;
  /** Electron userData dir. */
  userDataDir: string;
  /** Tenon-private pi agent dir (auth.json, settings.json, ...). */
  agentDir: string;
  /** Tenon-private pi session storage root. */
  sessionDir: string;
  piVersion: string;
  platform: string;
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export interface TenonProject {
  id: string;
  path: string;
  name: string;
  addedAt: number;
  lastSessionPath?: string;
}

// ---------------------------------------------------------------------------
// Sessions (scanned from the Tenon-private session store)
// ---------------------------------------------------------------------------

export interface SessionSummary {
  path: string;
  /** Session id parsed from the file name, when available. */
  sessionId?: string;
  cwd?: string;
  mtime: number;
  size: number;
}

// ---------------------------------------------------------------------------
// Auth (pi auth.json management)
// ---------------------------------------------------------------------------

export interface ProviderCredentialStatus {
  provider: string;
  type: "api_key" | "oauth" | "shell_command" | "env";
  configured: boolean;
}

/**
 * Built-in provider catalog shown in settings. Mirrors pi-ai providers; keys
 * are written to the Tenon-private auth.json as `{ type: "api_key", key }`.
 */
export const PROVIDER_CATALOG: ReadonlyArray<{
  id: string;
  label: string;
  keyEnv: string;
  docsUrl?: string;
}> = [
  { id: "anthropic", label: "Anthropic", keyEnv: "ANTHROPIC_API_KEY", docsUrl: "https://console.anthropic.com/settings/keys" },
  { id: "openai", label: "OpenAI", keyEnv: "OPENAI_API_KEY", docsUrl: "https://platform.openai.com/api-keys" },
  { id: "openai-codex", label: "OpenAI Codex (ChatGPT)", keyEnv: "OPENAI_API_KEY" },
  { id: "google", label: "Google Gemini", keyEnv: "GEMINI_API_KEY", docsUrl: "https://aistudio.google.com/apikey" },
  { id: "deepseek", label: "DeepSeek", keyEnv: "DEEPSEEK_API_KEY", docsUrl: "https://platform.deepseek.com/api_keys" },
  { id: "zai", label: "Z.ai (GLM)", keyEnv: "ZAI_API_KEY", docsUrl: "https://z.ai/manage/apikey" },
  { id: "moonshot", label: "Moonshot (Kimi)", keyEnv: "MOONSHOT_API_KEY" },
  { id: "minimax", label: "MiniMax", keyEnv: "MINIMAX_API_KEY" },
  { id: "qwen", label: "Qwen", keyEnv: "QWEN_API_KEY" },
  { id: "openrouter", label: "OpenRouter", keyEnv: "OPENROUTER_API_KEY", docsUrl: "https://openrouter.ai/keys" },
  { id: "xai", label: "xAI (Grok)", keyEnv: "XAI_API_KEY" },
  { id: "groq", label: "Groq", keyEnv: "GROQ_API_KEY" },
  { id: "cerebras", label: "Cerebras", keyEnv: "CEREBRAS_API_KEY" },
  { id: "mistral", label: "Mistral", keyEnv: "MISTRAL_API_KEY" },
  { id: "fireworks", label: "Fireworks", keyEnv: "FIREWORKS_API_KEY" },
  { id: "together", label: "Together AI", keyEnv: "TOGETHER_API_KEY" },
];

// ---------------------------------------------------------------------------
// Agent host
// ---------------------------------------------------------------------------

export type HostStatus = "stopped" | "starting" | "ready" | "error" | "stopped-with-error";

export interface PromptRequest {
  projectPath: string;
  message: string;
  /** Required while the agent is streaming. */
  streamingBehavior?: "steer" | "followUp";
}

// ---------------------------------------------------------------------------
// Push events (main → renderer)
// ---------------------------------------------------------------------------

export type TenonEvent =
  | { kind: "hostStatus"; projectPath: string; status: HostStatus; error?: string }
  | { kind: "agent"; projectPath: string; event: JsonAgentSessionEvent }
  | { kind: "extensionUi"; projectPath: string; request: unknown }
  | { kind: "settingsChanged"; projects: TenonProject[]; activeProjectId: string | null };

// ---------------------------------------------------------------------------
// Invoke channel map (single source of truth for typed ipc)
// ---------------------------------------------------------------------------

export interface TenonInvokeMap {
  "app:info": { in: void; out: AppInfo };
  "projects:list": { in: void; out: { projects: TenonProject[]; activeProjectId: string | null } };
  "projects:add": { in: void; out: TenonProject };
  "projects:remove": { in: { id: string }; out: { projects: TenonProject[]; activeProjectId: string | null } };
  "projects:setActive": { in: { id: string }; out: void };
  "auth:status": { in: void; out: ProviderCredentialStatus[] };
  "auth:setApiKey": { in: { provider: string; key: string }; out: void };
  "auth:remove": { in: { provider: string }; out: void };
  "agent:start": { in: { projectPath: string }; out: { state: RpcSessionState; messages: AgentMessage[] } };
  "agent:ensure": { in: { projectPath: string; resumeSessionPath?: string }; out: { state: RpcSessionState; messages: AgentMessage[] } };
  "agent:stop": { in: { projectPath: string }; out: void };
  "agent:prompt": { in: PromptRequest; out: void };
  "agent:steer": { in: { projectPath: string; message: string }; out: void };
  "agent:abort": { in: { projectPath: string }; out: void };
  "agent:getState": { in: { projectPath: string }; out: RpcSessionState };
  "agent:getMessages": { in: { projectPath: string }; out: { messages: AgentMessage[] } };
  "agent:getAvailableModels": { in: { projectPath: string }; out: { models: Model<any>[] } };
  "agent:setModel": { in: { projectPath: string; provider: string; modelId: string }; out: { state: RpcSessionState } };
  "agent:setThinkingLevel": { in: { projectPath: string; level: ThinkingLevel }; out: void };
  "agent:getThinkingLevels": { in: { projectPath: string }; out: { levels: ThinkingLevel[] } };
  "agent:newSession": { in: { projectPath: string; name?: string }; out: { state: RpcSessionState } };
  "agent:switchSession": { in: { projectPath: string; sessionPath: string }; out: { state: RpcSessionState; messages: AgentMessage[] } };
  "agent:setSessionName": { in: { projectPath: string; name: string }; out: void };
  "sessions:list": { in: { projectPath: string }; out: { sessions: SessionSummary[] } };
}

export type TenonInvokeChannel = keyof TenonInvokeMap;
export type TenonInvokeIn<C extends TenonInvokeChannel> = TenonInvokeMap[C]["in"];
export type TenonInvokeOut<C extends TenonInvokeChannel> = TenonInvokeMap[C]["out"];
