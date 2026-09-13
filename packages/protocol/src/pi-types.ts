/**
 * Type re-exports from the pi agent packages.
 *
 * These are type-only: nothing from this module reaches the bundle at runtime.
 * Types come from the pinned pi version installed in the workspace, so the
 * Tenon protocol layer can never drift from the engine we actually spawn.
 */
export type {
  RpcCommand,
  RpcResponse,
  RpcSessionState,
  RpcExtensionUIRequest,
  RpcExtensionUIResponse,
} from "@earendil-works/pi-coding-agent";
export type { JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";
export type {
  SessionEntry,
  SessionTreeNode,
  SessionStats,
  CompactionResult,
  AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
export type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
export type {
  Model,
  Usage,
  ImageContent,
  TextContent,
  ThinkingContent,
  ToolCall,
  UserMessage,
  AssistantMessage,
  ToolResultMessage,
  Message,
  Api,
  ProviderId,
} from "@earendil-works/pi-ai";
