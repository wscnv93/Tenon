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
};
