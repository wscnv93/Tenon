import { useEffect, useRef } from "react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { api } from "./lib/api";
import { Sidebar } from "./components/Sidebar";
import { ThreadView } from "./components/ThreadView";
import { Composer } from "./components/Composer";
import { SettingsDialog } from "./components/SettingsDialog";
import {
  activeProjectAtom,
  activeProjectIdAtom,
  agentStoreAtom,
  appInfoAtom,
  authStatusAtom,
  emptyAgentStore,
  leftCollapsedAtom,
  modelsAtom,
  projectsAtom,
  rightCollapsedAtom,
  sessionsAtom,
  agentEventToStore,
} from "./state";
import type { TenonProject } from "@protocol/ipc";

function Welcome() {
  const setProjects = useSetAtom(projectsAtom);
  const setActiveId = useSetAtom(activeProjectIdAtom);
  const openProject = async (): Promise<void> => {
    try {
      await api.addProject();
    } catch {
      // cancelled
    }
  };
  void setProjects;
  void setActiveId;
  return (
    <div className="welcome">
      <div className="welcome-card">
        <div className="welcome-logo">桥</div>
        <h1>Tenon</h1>
        <p>基于 pi 引擎的编程客户端。任意厂商模型、沙箱执行、代码图谱、全程可回溯。</p>
        <button type="button" className="btn btn-primary" onClick={() => void openProject()}>
          打开代码仓库
        </button>
      </div>
    </div>
  );
}

function RightPane() {
  return (
    <aside className="right-pane">
      <div className="right-tabs">
        <span className="right-tab active">检视</span>
        <span className="right-tab">文件</span>
        <span className="right-tab">轨迹</span>
      </div>
      <div className="right-pane-body">
        <div className="right-placeholder">
          <div className="right-placeholder-icon">⌥</div>
          <p>Diff 检视、文件树与轨迹回放将在这里呈现</p>
          <p className="right-placeholder-sub">M1:unified diff · 暂存/回退 · 行内评论</p>
        </div>
      </div>
    </aside>
  );
}

export default function App() {
  const projects = useAtomValue(projectsAtom);
  const activeProject = useAtomValue(activeProjectAtom);
  const setAppInfo = useSetAtom(appInfoAtom);
  const setProjects = useSetAtom(projectsAtom);
  const setActiveId = useSetAtom(activeProjectIdAtom);
  const setAuth = useSetAtom(authStatusAtom);
  const setSessions = useSetAtom(sessionsAtom);
  const setModels = useSetAtom(modelsAtom);
  const [agentStore, setAgentStore] = useAtom(agentStoreAtom);
  const [leftCollapsed, setLeftCollapsed] = useAtom(leftCollapsedAtom);
  const [rightCollapsed, setRightCollapsed] = useAtom(rightCollapsedAtom);
  const activePathRef = useRef<string | null>(null);
  const bootstrappedRef = useRef(false);

  activePathRef.current = activeProject?.path ?? null;

  // Pane collapse shortcuts: ⌘B left, ⌘\ right.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const mod = event.metaKey || event.ctrlKey;
      if (!mod || event.altKey || event.shiftKey) return;
      if (event.key === "b" || event.key === "B") {
        event.preventDefault();
        setLeftCollapsed(!leftCollapsed);
      } else if (event.key === "\\") {
        event.preventDefault();
        setRightCollapsed(!rightCollapsed);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [leftCollapsed, rightCollapsed, setLeftCollapsed, setRightCollapsed]);

  // Bootstrap: static data + event subscription.
  useEffect(() => {
    if (bootstrappedRef.current) return;
    bootstrappedRef.current = true;
    const unsubscribe = window.tenon.onEvent((event) => {
      if (event.kind === "settingsChanged") {
        setProjects(event.projects);
        setActiveId(event.activeProjectId);
        return;
      }
      setAgentStore((current) => agentEventToStore(event, activePathRef.current, current));
    });
    void (async () => {
      setAppInfo(await api.appInfo());
      const projectList = await api.listProjects();
      setProjects(projectList.projects);
      setActiveId(projectList.activeProjectId);
      setAuth(await api.authStatus());
    })();
    return () => {
      unsubscribe();
      bootstrappedRef.current = false;
    };
  }, [setAppInfo, setProjects, setActiveId, setAuth, setAgentStore]);

  // Activate agent host whenever the active project changes.
  useEffect(() => {
    if (!activeProject) return;
    let cancelled = false;
    void (async () => {
      setAgentStore({ ...emptyAgentStore, status: "starting" });
      try {
        const result = await api.agentEnsure(activeProject.path, activeProject.lastSessionPath);
        if (cancelled) return;
        setAgentStore((current) => ({ ...current, status: "ready", state: result.state, messages: result.messages }));
        const sessionList = await api.listSessions(activeProject.path);
        if (!cancelled) setSessions(sessionList.sessions);
        try {
          const modelResult = await api.agentGetModels(activeProject.path);
          if (!cancelled) setModels(modelResult.models);
        } catch {
          // Not authenticated yet — picker will guide the user to settings.
        }
      } catch (error) {
        if (!cancelled) {
          setAgentStore((current) => ({ ...current, status: "error", error: String(error) }));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeProject?.path, activeProject?.lastSessionPath, setAgentStore, setSessions, setModels]);

  // Refresh session list when the agent settles (first message creates the file).
  useEffect(() => {
    if (!activeProject) return;
    if (agentStore.status === "ready") {
      void api.listSessions(activeProject.path).then((result) => setSessions(result.sessions));
    }
  }, [agentStore.state?.sessionFile, agentStore.status, activeProject, setSessions]);

  void (void 0);

  return (
    <>
      {projects.length === 0 ? (
        <Welcome />
      ) : (
        <div className={`app ${leftCollapsed ? "app-l" : ""} ${rightCollapsed ? "app-r" : ""}`}>
          <Sidebar />
          <main className="center">
            <div className="center-header">
              <button
                type="button"
                className="icon-btn pane-toggle"
                title={leftCollapsed ? "展开侧栏 (⌘B)" : "折叠侧栏 (⌘B)"}
                onClick={() => setLeftCollapsed(!leftCollapsed)}
              >
                {leftCollapsed ? "»" : "«"}
              </button>
              <span className="center-title">{activeProject?.name ?? "Tenon"}</span>
              <span className="center-sub">{activeProject?.path}</span>
              <button
                type="button"
                className="icon-btn pane-toggle pane-toggle-right"
                title={rightCollapsed ? "展开检视栏 (⌘\\)" : "折叠检视栏 (⌘\\)"}
                onClick={() => setRightCollapsed(!rightCollapsed)}
              >
                {rightCollapsed ? "«" : "»"}
              </button>
            </div>
            <ThreadView />
            <Composer />
          </main>
          <RightPane />
        </div>
      )}
      <SettingsDialog />
    </>
  );
}
