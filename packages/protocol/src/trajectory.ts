/**
 * Trajectory view model: pi session entries → replayable turns.
 *
 * Pure and renderer-safe: takes the append-order entry list from RPC
 * `get_entries` (includes abandoned branches) and produces turn segments
 * for the timeline plus per-turn step lists for the inspector.
 * "Active" = on the parent chain from the current leaf; everything else is
 * abandoned history, still inspectable and forkable.
 */
import type { SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";

const asAssistant = (message: AgentMessage): AssistantMessage => message as AssistantMessage;
const asUser = (message: AgentMessage): UserMessage => message as UserMessage;

export interface TrajStep {
  entryId: string;
  kind: "user" | "assistant" | "toolResult" | "compaction" | "model_change" | "thinking_level" | "other";
  label: string;
  /** ISO timestamp of the entry. */
  ts: string;
  tokens?: number;
  cost?: number;
  isError?: boolean;
  forkable?: boolean;
}

export interface TrajTurn {
  id: string;
  /** First user message entry id — the fork anchor for this turn. */
  anchorEntryId: string;
  label: string;
  startTs: string;
  endTs: string;
  durationMs: number;
  tokens: number;
  cost: number;
  toolCalls: number;
  active: boolean;
  steps: TrajStep[];
}

export interface TrajectoryView {
  turns: TrajTurn[];
  leafId: string | null;
  totals: { turns: number; tokens: number; cost: number; abandoned: number };
}

function stepOf(entry: SessionEntry): TrajStep | null {
  const base = { entryId: entry.id, ts: entry.timestamp };
  if (entry.type === "message") {
    const message = entry.message as AgentMessage;
    if (message.role === "user") {
      const text = typeof message.content === "string" ? message.content : textOf(message.content);
      return { ...base, kind: "user", label: text, forkable: true };
    }
    if (message.role === "assistant") {
      const assistant = asAssistant(message);
      const toolCalls = assistant.content.filter((block) => block.type === "toolCall").length;
      const text = textOf(assistant.content);
      return {
        ...base,
        kind: "assistant",
        label: toolCalls > 0 && !text ? `${toolCalls} 个工具调用` : text,
        tokens: message.usage?.totalTokens,
        cost: message.usage?.cost?.total,
      };
    }
    if (message.role === "toolResult") {
      return {
        ...base,
        kind: "toolResult",
        label: message.toolName,
        isError: message.isError,
      };
    }
    return { ...base, kind: "other", label: message.role };
  }
  if (entry.type === "compaction") return { ...base, kind: "compaction", label: "上下文压缩" };
  if (entry.type === "model_change") return { ...base, kind: "model_change", label: "模型切换" };
  if (entry.type === "thinking_level_change") return { ...base, kind: "thinking_level", label: "思考档位调整" };
  return null;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((block: { type?: string }) => block?.type === "text")
      .map((block: { text?: string }) => block.text ?? "")
      .join(" ");
  }
  return "";
}

const ts = (value: string): number => Date.parse(value) || 0;

export function buildTrajectory(entries: SessionEntry[], leafId: string | null): TrajectoryView {
  // Active path: leaf → root parent chain.
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const activeIds = new Set<string>();
  let cursor = leafId ? byId.get(leafId) : undefined;
  while (cursor) {
    activeIds.add(cursor.id);
    cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
  }

  const turns: TrajTurn[] = [];
  let current: TrajTurn | null = null;

  for (const entry of entries) {
    if (entry.type === "message" && (entry as SessionMessageEntry).message.role === "user") {
      const message = asUser((entry as SessionMessageEntry).message);
      current = {
        id: entry.id,
        anchorEntryId: entry.id,
        label: textOf(message.content).slice(0, 120) || "(空消息)",
        startTs: entry.timestamp,
        endTs: entry.timestamp,
        durationMs: 0,
        tokens: 0,
        cost: 0,
        toolCalls: 0,
        active: activeIds.has(entry.id),
        steps: [],
      };
      turns.push(current);
    }
    if (!current) continue;
    const step = stepOf(entry);
    if (step) current.steps.push(step);
    if (step?.kind === "assistant") {
      current.tokens += step.tokens ?? 0;
      current.cost += step.cost ?? 0;
      const message = asAssistant((entry as SessionMessageEntry).message);
      current.toolCalls += message.content.filter((block) => block.type === "toolCall").length;
    }
    current.endTs = entry.timestamp;
    current.durationMs = Math.max(0, ts(current.endTs) - ts(current.startTs));
  }

  const totals = {
    turns: turns.length,
    tokens: turns.reduce((sum, turn) => sum + turn.tokens, 0),
    cost: turns.reduce((sum, turn) => sum + turn.cost, 0),
    abandoned: turns.filter((turn) => !turn.active).length,
  };
  return { turns, leafId, totals };
}
