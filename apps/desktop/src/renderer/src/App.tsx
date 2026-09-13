import { useEffect, useRef } from "react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { api } from "./lib/api";
import { Sidebar } from "./components/Sidebar";
import { ThreadView } from "./components/ThreadView";
import { Composer } from "./components/Composer";
import { SettingsDialog } from "./components/SettingsDialog";
import { ReviewPane } from "./components/ReviewPane";
import { FilesPane } from "./components/FilesPane";
import { ApprovalCards } from "./components/ApprovalCards";
import { TrajectoryPane } from "./components/TrajectoryPane";
import { TerminalDrawer } from "./components/TerminalDrawer";
import { TIcon } from "./components/TIcon";
import {
  activeProjectAtom,
  activeProjectIdAtom,
  agentStoreAtom,
  appInfoAtom,
  applyTheme,
  authStatusAtom,
  emptyAgentStore,
  leftCollapsedAtom,
  modelsAtom,
  projectsAtom,
  rightCollapsedAtom,
  rightTabAtom,
  sessionsAtom,
  agentEventToStore,
  agentSettledTickAtom,
  themePreferenceAtom,
} from "./state";
import type { TenonProject } from "@protocol/ipc";

function Welcome() {
  const openProject = async (): Promise<void> => {
    try {
      await api.addProject();
    } catch {
      // Cancelled dialog.
    }
  };
  return (
    <div className="welcome">
      <div className="welcome-card">
        <span className="badge"><TIcon size={30} /></span>
        <div className="welcome-wordmark">TENON</div>
        <p>基于 pi 引擎的编程客户端。任意厂商模型、沙箱执行、代码图谱、全程可回溯。</p>
        <button type="button" className="btn btn-primary" onClick={() => void openProject()}>
          打开代码仓库
        </button>
      </div>
    </div>
  );
}

function RightPane() {
  const [tab, setTab] = useAtom(rightTabAtom);
  return (
    <aside className="right-pane">
      <div className="right-tabs">
        {(["review", "files", "trajectory"] as const).map((key) => (
          <button
            key={key}
            type="button"
            className={`right-tab ${tab === key ? "active" : ""}`}
            onClick={() => setTab(key)}
          >
            {key === "review" ? "检视" : key === "files" ? "文件" : "轨迹"}
          </button>
        ))}
      </div>
      <div className="right-pane-body">
        {tab === "review" && <ReviewPane />}
        {tab === "files" && <FilesPane />}
        {tab === "trajectory" && <TrajectoryPane />}
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
  const setSettledTick = useSetAtom(agentSettledTickAtom);
  const [agentStore, setAgentStore] = useAtom(agentStoreAtom);
  const [leftCollapsed, setLeftCollapsed] = useAtom(leftCollapsedAtom);
  const [rightCollapsed, setRightCollapsed] = useAtom(rightCollapsedAtom);
  const [themePreference] = useAtom(themePreferenceAtom);
  const activePathRef = useRef<string | null>(null);
  const bootstrappedRef = useRef(false);

  activePathRef.current = activeProject?.path ?? null;

  // Theme: apply preference now; follow the OS while set to "system".
  useEffect(() => {
    applyTheme(themePreference);
    if (themePreference !== "system") return;
    const media = window.matchMedia("(prefers-color-scheme: light)");
    const onChange = (): void => applyTheme("system");
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [themePreference]);

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
      if (event.kind === "agent" && event.event.type === "agent_settled") {
        setSettledTick((tick) => tick + 1);
      }
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
            <ApprovalCards />
            <Composer />
            <TerminalDrawer />
          </main>
          <RightPane />
        </div>
      )}
      <SettingsDialog />
    </>
  );
}
