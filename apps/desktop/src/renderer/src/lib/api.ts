import type { TenonInvokeChannel, TenonInvokeIn, TenonInvokeOut } from "@protocol/ipc";

function invoke<C extends TenonInvokeChannel>(channel: C, payload: TenonInvokeIn<C>): Promise<TenonInvokeOut<C>> {
  return window.tenon.invoke(channel, payload) as Promise<TenonInvokeOut<C>>;
}

export const api = {
  appInfo: () => invoke("app:info", undefined as never),
  listProjects: () => invoke("projects:list", undefined as never),
  addProject: () => invoke("projects:add", undefined as never),
  removeProject: (id: string) => invoke("projects:remove", { id }),
  setActiveProject: (id: string) => invoke("projects:setActive", { id }),
  authStatus: () => invoke("auth:status", undefined as never),
  setApiKey: (provider: string, key: string) => invoke("auth:setApiKey", { provider, key }),
  removeCredential: (provider: string) => invoke("auth:remove", { provider }),
  agentEnsure: (projectPath: string, resumeSessionPath?: string) =>
    invoke("agent:ensure", { projectPath, resumeSessionPath }),
  agentStop: (projectPath: string) => invoke("agent:stop", { projectPath }),
  agentPrompt: (projectPath: string, message: string) => invoke("agent:prompt", { projectPath, message }),
  agentAbort: (projectPath: string) => invoke("agent:abort", { projectPath }),
  agentSetModel: (projectPath: string, provider: string, modelId: string) =>
    invoke("agent:setModel", { projectPath, provider, modelId }),
  agentGetModels: (projectPath: string) => invoke("agent:getAvailableModels", { projectPath }),
  agentSetThinking: (projectPath: string, level: string) =>
    invoke("agent:setThinkingLevel", { projectPath, level: level as never }),
  agentGetThinkingLevels: (projectPath: string) => invoke("agent:getThinkingLevels", { projectPath }),
  agentNewSession: (projectPath: string, name?: string) => invoke("agent:newSession", { projectPath, name }),
  agentSwitchSession: (projectPath: string, sessionPath: string) =>
    invoke("agent:switchSession", { projectPath, sessionPath }),
  agentSetSessionName: (projectPath: string, name: string) =>
    invoke("agent:setSessionName", { projectPath, name }),
  listSessions: (projectPath: string) => invoke("sessions:list", { projectPath }),
  agentGetTree: (projectPath: string) => invoke("agent:getTree", { projectPath }),
  agentForkAt: (projectPath: string, entryId: string) => invoke("agent:forkAt", { projectPath, entryId }),
  reviewSendComments: (projectPath: string, comments: { path: string; line: number; text: string }[]) =>
    invoke("review:sendComments", { projectPath, comments }),
  gitStatus: (projectPath: string) => invoke("git:status", { projectPath }),
  gitDiff: (projectPath: string, scope: "uncommitted" | "branch" | "turn", view: "worktree" | "staged") =>
    invoke("git:diff", { projectPath, scope, view }),
  gitStageFile: (projectPath: string, path: string) => invoke("git:stageFile", { projectPath, path }),
  gitUnstageFile: (projectPath: string, path: string) => invoke("git:unstageFile", { projectPath, path }),
  gitDiscardFile: (projectPath: string, path: string) => invoke("git:discardFile", { projectPath, path }),
  gitStageHunk: (projectPath: string, path: string, patch: string) =>
    invoke("git:stageHunk", { projectPath, path, patch }),
  gitUnstageHunk: (projectPath: string, path: string, patch: string) =>
    invoke("git:unstageHunk", { projectPath, path, patch }),
  gitDiscardHunk: (projectPath: string, path: string, patch: string) =>
    invoke("git:discardHunk", { projectPath, path, patch }),
  gitStageAll: (projectPath: string) => invoke("git:stageAll", { projectPath }),
  gitUnstageAll: (projectPath: string) => invoke("git:unstageAll", { projectPath }),
  getExecMode: () => invoke("agent:getExecMode", undefined as never),
  setExecMode: (mode: string) => invoke("agent:setExecMode", { mode: mode as never }),
  extensionUiResponse: (projectPath: string, id: string, response: Record<string, unknown>) =>
    invoke("agent:extensionUiResponse", { projectPath, id, response }),
};
