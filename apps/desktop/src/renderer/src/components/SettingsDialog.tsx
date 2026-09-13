import { useState } from "react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { api } from "../lib/api";
import { PROVIDER_CATALOG } from "@protocol/ipc";
import { activeProjectAtom, appInfoAtom, authStatusAtom, modelsAtom, settingsOpenAtom } from "../state";

const TYPE_LABEL: Record<string, string> = {
  api_key: "API Key",
  oauth: "OAuth 订阅",
  shell_command: "命令注入",
  env: "环境变量",
};

export function SettingsDialog() {
  const [open, setOpen] = useAtom(settingsOpenAtom);
  const auth = useAtomValue(authStatusAtom);
  const setAuth = useSetAtom(authStatusAtom);
  const appInfo = useAtomValue(appInfoAtom);
  const project = useAtomValue(activeProjectAtom);
  const setModels = useSetAtom(modelsAtom);
  const [busy, setBusy] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  if (!open) return null;

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
        // Refresh the model list so the new provider's models appear immediately.
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
    <div className="modal-overlay" onClick={() => setOpen(false)}>
      <div className="modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <h2>设置</h2>
          <button type="button" className="icon-btn" onClick={() => setOpen(false)}>
            ×
          </button>
        </div>

        <div className="modal-body">
          <div className="settings-section-title">模型厂商 · API Key</div>
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
            pi 引擎以内置方式随 Tenon 分发与更新,无需单独安装;上述目录均在 Tenon 私有数据区内,卸载即随系统清理。
          </p>
        </div>
      </div>
    </div>
  );
}
