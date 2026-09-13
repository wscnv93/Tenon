import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { api } from "../lib/api";
import {
  activeProjectAtom,
  activeProjectIdAtom,
  agentStoreAtom,
  appInfoAtom,
  projectsAtom,
  sessionsAtom,
  settingsOpenAtom,
} from "../state";

function formatTime(ms: number): string {
  const date = new Date(ms);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  if (sameDay) return date.toTimeString().slice(0, 5);
  return `${date.getMonth() + 1}/${date.getDate()} ${date.toTimeString().slice(0, 5)}`;
}

export function Sidebar() {
  const projects = useAtomValue(projectsAtom);
  const activeId = useAtomValue(activeProjectIdAtom);
  const setActiveId = useSetAtom(activeProjectIdAtom);
  const setProjects = useSetAtom(projectsAtom);
  const activeProject = useAtomValue(activeProjectAtom);
  const sessions = useAtomValue(sessionsAtom);
  const store = useAtomValue(agentStoreAtom);
  const appInfo = useAtomValue(appInfoAtom);
  const setSettingsOpen = useSetAtom(settingsOpenAtom);
  const [, setAgentStore] = useAtom(agentStoreAtom);

  const setSessionsList = useSetAtom(sessionsAtom);

  const refreshSessions = async (): Promise<void> => {
    if (!activeProject) return;
    const result = await api.listSessions(activeProject.path);
    setSessionsList(result.sessions);
  };

  const openProject = async (): Promise<void> => {
    try {
      await api.addProject();
    } catch {
      // Cancelled dialog.
    }
  };

  const removeProject = async (id: string): Promise<void> => {
    const project = projects.find((entry) => entry.id === id);
    if (!project) return;
    if (!window.confirm(`移除项目「${project.name}」?(不会删除磁盘文件与会话记录)`)) return;
    const result = await api.removeProject(id);
    setProjects(result.projects);
    if (result.activeProjectId) setActiveId(result.activeProjectId);
    else setAgentStore({ status: "stopped", state: null, messages: [], toolRuns: {}, queue: { steering: [], followUp: [] }, notices: [] });
  };

  const newThread = async (): Promise<void> => {
    if (!activeProject) return;
    const result = await api.agentNewSession(activeProject.path);
    setAgentStore((prev) => ({ ...prev, state: result.state, messages: [], toolRuns: {}, notices: [] }));
    void refreshSessions();
  };

  const switchSession = async (path: string): Promise<void> => {
    if (!activeProject) return;
    const result = await api.agentSwitchSession(activeProject.path, path);
    setAgentStore((prev) => ({ ...prev, state: result.state, messages: result.messages, toolRuns: {}, notices: [] }));
    void refreshSessions();
  };

  const statusColor =
    store.status === "ready" ? "var(--success)" : store.status === "error" ? "var(--danger)" : "var(--text-dim)";

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <span className="sidebar-logo">桥</span>
        <span className="sidebar-title">Tenon</span>
        <span className="sidebar-version">{appInfo ? `v${appInfo.appVersion} · pi ${appInfo.piVersion}` : ""}</span>
      </div>

      <div className="sidebar-section">
        <div className="sidebar-section-title">
          项目
          <button type="button" className="icon-btn" title="打开代码仓库" onClick={() => void openProject()}>
            +
          </button>
        </div>
        <div className="sidebar-projects">
          {projects.length === 0 && <div className="sidebar-empty">尚未打开项目</div>}
          {projects.map((project) => (
            <div
              key={project.id}
              className={`sidebar-project ${project.id === activeId ? "active" : ""}`}
              onClick={() => setActiveId(project.id)}
              role="button"
              tabIndex={0}
              onKeyDown={(event) => event.key === "Enter" && setActiveId(project.id)}
            >
              <span className="sidebar-project-name">{project.name}</span>
              <button
                type="button"
                className="icon-btn icon-btn-subtle"
                title="移除"
                onClick={(event) => {
                  event.stopPropagation();
                  void removeProject(project.id);
                }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      </div>

      {activeProject && (
        <div className="sidebar-section sidebar-section-grow">
          <div className="sidebar-section-title">
            会话
            <button type="button" className="icon-btn" title="新线程" onClick={() => void newThread()}>
              +
            </button>
          </div>
          <div className="sidebar-sessions">
            {sessions.length === 0 && <div className="sidebar-empty">暂无历史会话</div>}
            {sessions.map((session) => {
              const active = store.state?.sessionFile === session.path;
              return (
                <button
                  key={session.path}
                  type="button"
                  className={`sidebar-session ${active ? "active" : ""}`}
                  onClick={() => void switchSession(session.path)}
                >
                  <span className={`sidebar-session-dot ${active ? "on" : ""}`} />
                  <span className="sidebar-session-time">{formatTime(session.mtime)}</span>
                  <span className="sidebar-session-size">{Math.max(1, Math.round(session.size / 1024))}k</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div className="sidebar-footer">
        <button type="button" className="sidebar-settings" onClick={() => setSettingsOpen(true)}>
          ⚙ 设置
        </button>
        <span className="sidebar-status" title={store.status}>
          <span className="sidebar-status-dot" style={{ background: statusColor }} />
          {store.status === "ready" ? "引擎就绪" : store.status === "starting" ? "启动中…" : store.status === "error" ? "引擎异常" : "未启动"}
        </span>
      </div>
    </aside>
  );
}
