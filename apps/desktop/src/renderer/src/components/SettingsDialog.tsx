import { useEffect, useState } from "react";
// useAtom imported below
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { api } from "../lib/api";
import { PROVIDER_CATALOG } from "@protocol/ipc";
import type { UpdateProgressEvent } from "@protocol/ipc";
import {
  activeProjectAtom,
  appInfoAtom,
  authStatusAtom,
  modelsAtom,
  settingsOpenAtom,
  updateProgressAtom,
} from "../state";

type Section = "general" | "models";

const TYPE_LABEL: Record<string, string> = {
  api_key: "API Key",
  oauth: "OAuth 订阅",
  shell_command: "命令注入",
  env: "环境变量",
};

export function SettingsDialog() {
  const [open, setOpen] = useAtom(settingsOpenAtom);
  const [section, setSection] = useState<Section>("general");
  if (!open) return null;

  return (
    <div className="modal-overlay" onClick={() => setOpen(false)}>
      <div className="modal modal-wide" onClick={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <h2>设置</h2>
          <button type="button" className="icon-btn" onClick={() => setOpen(false)}>
            ×
          </button>
        </div>
        <div className="modal-columns">
          <nav className="settings-nav">
            <button
              type="button"
              className={`settings-nav-item ${section === "general" ? "on" : ""}`}
              onClick={() => setSection("general")}
            >
              通用
            </button>
            <button
              type="button"
              className={`settings-nav-item ${section === "models" ? "on" : ""}`}
              onClick={() => setSection("models")}
            >
              模型与厂商
            </button>
          </nav>
          <div className="modal-body modal-body-flush">
            {section === "general" && <GeneralSection />}
            {section === "models" && <ModelsSection />}
          </div>
        </div>
      </div>
    </div>
  );
}

function GeneralSection() {
  const appInfo = useAtomValue(appInfoAtom);
  const [repo, setRepo] = useState("");
  const [savedRepo, setSavedRepo] = useState("");
  const [check, setCheck] = useState<{
    hasUpdate: boolean;
    latestVersion?: string;
    notes?: string;
    htmlUrl?: string;
    error?: string;
  } | null>(null);
  const [progress] = useAtom(updateProgressAtom);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api.getUpdateRepo().then((result) => {
      setRepo(result.repo);
      setSavedRepo(result.repo);
    });
  }, []);

  const checkNow = async (): Promise<void> => {
    setBusy(true);
    setCheck(null);
    try {
      const result = (await api.updateCheck(repo.trim())) as typeof check;
      setCheck(result);
    } finally {
      setBusy(false);
    }
  };

  const installNow = async (): Promise<void> => {
    setBusy(true);
    try {
      await api.updateInstall(savedRepo.trim());
    } finally {
      setBusy(false);
    }
  };

  const saveRepo = async (): Promise<void> => {
    await api.setUpdateRepo(repo.trim());
    setSavedRepo(repo.trim());
  };

  const downloading = progress?.stage === "downloading";
  const installing = progress?.stage === "installing";

  return (
    <>
      <div className="settings-section-title">应用更新</div>
      <p className="settings-note">
        填写 GitHub 仓库(owner/repo),Tenon 会从该仓库的 Releases 检查新版本;
        发现新版本后一键下载并替换当前安装(需要 release 中包含对应架构的 DMG)。
      </p>
      <div className="provider-row-input update-repo-row">
        <input
          value={repo}
          placeholder="例如 your-name/Tenon"
          onChange={(event) => setRepo(event.target.value)}
        />
        <button type="button" className="btn btn-small" disabled={repo.trim() === savedRepo.trim()} onClick={() => void saveRepo()}>
          保存
        </button>
        <button type="button" className="btn btn-small" disabled={!savedRepo.trim() || busy} onClick={() => void checkNow()}>
          {busy && !progress ? "检查中…" : "检查更新"}
        </button>
      </div>

      {check && !check.hasUpdate && (
        <div className="pane-note">
          {check.error ?? `已是最新版本(v${check.latestVersion ?? appInfo?.appVersion ?? "?"})`}
        </div>
      )}

      {check?.hasUpdate && (
        <div className="update-card">
          <div className="update-card-head">
            <span className="update-version">
              新版本 v{check.latestVersion}
            </span>
            {check.htmlUrl && (
              <a className="link" href={check.htmlUrl} target="_blank" rel="noreferrer">
                查看说明
              </a>
            )}
          </div>
          {check.notes && <pre className="update-notes">{check.notes.slice(0, 800)}</pre>}
          {downloading ? (
            <div className="update-progress">
              <div className="update-progress-bar">
                <div style={{ width: `${Math.max(4, progress?.percent ?? 0)}%` }} />
              </div>
              <span className="mono">{progress?.percent && progress.percent >= 0 ? `${progress.percent}%` : "下载中…"}</span>
            </div>
          ) : installing ? (
            <div className="pane-note">正在替换应用,完成后会自动重启…</div>
          ) : (
            <button type="button" className="btn btn-send" disabled={busy} onClick={() => void installNow()}>
              一键下载并更新
            </button>
          )}
        </div>
      )}

      {progress?.stage === "error" && <div className="pane-note pane-note-error">{progress.error}</div>}

      <div className="settings-section-title">关于</div>
      <div className="about-grid">
        <span>版本</span>
        <span>{appInfo ? `Tenon ${appInfo.appVersion} · pi 引擎 ${appInfo.piVersion}` : "—"}</span>
        <span>引擎数据目录</span>
        <span className="mono">{appInfo?.agentDir ?? "—"}</span>
        <span>会话存储</span>
        <span className="mono">{appInfo?.sessionDir ?? "—"}</span>
      </div>
      <p className="settings-note">
        pi 引擎以内置方式随 Tenon 分发与更新;上述目录均在 Tenon 私有数据区内,密钥与会话不会进入任何代码仓库。
      </p>
    </>
  );
}

function ModelsSection() {
  const auth = useAtomValue(authStatusAtom);
  const setAuth = useSetAtom(authStatusAtom);
  const appInfo = useAtomValue(appInfoAtom);
  const project = useAtomValue(activeProjectAtom);
  const setModels = useSetAtom(modelsAtom);
  const [busy, setBusy] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const statusOf = (provider: string) => auth.find((entry) => entry.provider === provider);

  const save = async (provider: string): Promise<void> => {
    const key = drafts[provider]?.trim();
    if (!key) return;
    setBusy(provider);
    try {
      await api.setApiKey(provider, key);
      setAuth(await api.authStatus());
      setDrafts((prev) => ({ ...prev, [provider]: "" }));
      if (project) {
        try {
          const result = await api.agentGetModels(project.path);
          setModels(result.models);
        } catch {
          // Engine may not be running yet.
        }
      }
    } catch (error) {
      window.alert(`保存失败:${String(error)}`);
    } finally {
      setBusy(null);
    }
  };

  const remove = async (provider: string): Promise<void> => {
    setBusy(provider);
    try {
      await api.removeCredential(provider);
      setAuth(await api.authStatus());
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <div className="settings-section-title">厂商 API Key</div>
      <p className="settings-note">
        密钥保存在本机 Tenon 私有目录(Tenon 不上传任何密钥)。配置后,模型列表会在打开模型选择器时自动拉取。
        也支持 pi 的 <code>!shell 命令</code>(如 1Password)与 <code>$ENV_VAR</code> 引用写法。
      </p>
      <div className="provider-grid">
        {PROVIDER_CATALOG.map((provider) => {
          const status = statusOf(provider.id);
          const configured = status?.configured ?? false;
          return (
            <div key={provider.id} className={`provider-row ${configured ? "configured" : ""}`}>
              <div className="provider-row-head">
                <span className="provider-name">{provider.label}</span>
                <span className={`provider-badge ${configured ? "on" : ""}`}>
                  {configured ? TYPE_LABEL[status!.type] ?? "已配置" : "未配置"}
                </span>
                {configured && (
                  <button
                    type="button"
                    className="link link-danger"
                    disabled={busy === provider.id}
                    onClick={() => void remove(provider.id)}
                  >
                    清除
                  </button>
                )}
              </div>
              <div className="provider-row-input">
                <input
                  type="password"
                  autoComplete="off"
                  placeholder={configured ? "●●●●●●(已保存,可覆盖)" : "粘贴 API Key"}
                  value={drafts[provider.id] ?? ""}
                  onChange={(event) => setDrafts((prev) => ({ ...prev, [provider.id]: event.target.value }))}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void save(provider.id);
                  }}
                />
                <button
                  type="button"
                  className="btn btn-small"
                  disabled={busy === provider.id || !(drafts[provider.id] ?? "").trim()}
                  onClick={() => void save(provider.id)}
                >
                  {busy === provider.id ? "…" : "保存"}
                </button>
              </div>
              {provider.docsUrl && (
                <div className="provider-row-meta">
                  获取密钥:<span className="provider-doc">{provider.docsUrl}</span>
                </div>
              )}
            </div>
          );
        })}
      </div>
      {appInfo && (
        <p className="settings-note" style={{ marginTop: 14 }}>
          引擎数据目录:<span className="mono">{appInfo.agentDir}</span>(密钥与会话都在这里,卸载即清理)
        </p>
      )}
    </>
  );
}
