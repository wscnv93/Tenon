/**
 * App self-update via GitHub Releases: check latest release, download the
 * arch-matched DMG with progress, then swap the app in place from a detached
 * script and relaunch. Uses Electron `net` (Chromium stack) so the system
 * proxy applies — no env fiddling required.
 */
import { app, net } from "electron";
import { createWriteStream, existsSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { getPaths } from "./paths.js";

export interface UpdateCheck {
  currentVersion: string;
  hasUpdate: boolean;
  latestVersion?: string;
  notes?: string;
  assetUrl?: string;
  htmlUrl?: string;
  error?: string;
}

function semverGreater(candidate: string, current: string): boolean {
  const parse = (value: string): [number, number, number] => {
    const parts = value.replace(/^v/, "").split(".").map((piece) => Number.parseInt(piece, 10) || 0);
    return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
  };
  const [cMaj, cMin, cPat] = parse(candidate);
  const [uMaj, uMin, uPat] = parse(current);
  if (cMaj !== uMaj) return cMaj > uMaj;
  if (cMin !== uMin) return cMin > uMin;
  return cPat > uPat;
}

interface GhRelease {
  tag_name: string;
  body?: string;
  html_url: string;
  assets: Array<{ name: string; browser_download_url: string }>;
}

export function updateDmgPath(): string {
  return join(getPaths().userDataDir, "pending-update.dmg");
}

export async function checkUpdate(repo: string): Promise<UpdateCheck> {
  const currentVersion = app.getVersion();
  if (!repo.trim()) {
    return { currentVersion, hasUpdate: false, error: "未配置更新源" };
  }
  try {
    const response = await net.fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { "User-Agent": "Tenon-Desktop", Accept: "application/vnd.github+json" },
    });
    if (response.status === 404) {
      return { currentVersion, hasUpdate: false, error: "该仓库还没有 release" };
    }
    if (!response.ok) {
      return { currentVersion, hasUpdate: false, error: `GitHub 返回 ${response.status}` };
    }
    const release = (await response.json()) as GhRelease;
    const latestVersion = release.tag_name.replace(/^v/, "");
    const arch = process.arch === "arm64" ? "arm64" : "x64";
    const asset = release.assets.find((item) => item.name.endsWith(`-${arch}.dmg`));
    const hasUpdate = semverGreater(latestVersion, currentVersion);
    return {
      currentVersion,
      hasUpdate,
      latestVersion,
      notes: release.body?.slice(0, 2000),
      assetUrl: asset?.browser_download_url,
      htmlUrl: release.html_url,
      error: hasUpdate && !asset ? `新版本 ${latestVersion} 没有包含 ${arch} 的 DMG 资产` : undefined,
    };
  } catch (error) {
    return { currentVersion, hasUpdate: false, error: `检查失败:${error instanceof Error ? error.message : String(error)}` };
  }
}

export type UpdateProgress = (stage: "downloading" | "installing" | "done" | "error", percent?: number, error?: string) => void;

export async function downloadUpdate(assetUrl: string, onProgress: UpdateProgress): Promise<string> {
  const dmgPath = updateDmgPath();
  rmSync(dmgPath, { force: true });
  const response = await net.fetch(assetUrl);
  if (!response.ok || !response.body) {
    throw new Error(`下载失败:HTTP ${response.status}`);
  }
  const total = Number(response.headers.get("content-length") ?? 0);
  const out = createWriteStream(dmgPath);
  const reader = response.body.getReader();
  let received = 0;
  let lastNotified = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    out.write(Buffer.from(value));
    const percent = total > 0 ? Math.min(99, Math.round((received / total) * 100)) : -1;
    if (percent !== lastNotified && (percent % 5 === 0 || percent === -1)) {
      lastNotified = percent;
      onProgress("downloading", percent);
    }
  }
  await new Promise<void>((resolve, reject) => {
    out.end(() => resolve());
    out.on("error", reject);
  });
  onProgress("downloading", 100);
  return dmgPath;
}

/**
 * Swap-in script runs detached so the app can quit underneath it.
 * Replaces the app the current binary runs from when it lives in
 * /Applications; otherwise installs into /Applications.
 */
export function installUpdate(dmgPath: string): void {
  const execPath = process.execPath; // .../Tenon.app/Contents/MacOS/Electron
  const appDir = execPath.slice(0, execPath.indexOf(".app") + ".app".length);
  const target = app.isPackaged && appDir.startsWith("/Applications") ? "/Applications" : "/Applications";
  const script = [
    "#!/bin/bash",
    "set -e",
    `MNT=$(mktemp -d /tmp/tenon-update-XXXX)`,
    `hdiutil attach -nobrowse -quiet -mountpoint "$MNT" '${dmgPath}'`,
    `rm -rf '${target}/Tenon.app'`,
    `cp -R "$MNT/Tenon.app" '${target}/'`,
    `hdiutil detach "$MNT" -quiet`,
    `rm -f '${dmgPath}'`,
    "sleep 1",
    `open '${target}/Tenon.app'`,
    "rm -f '$0'",
  ].join("\n");
  const scriptPath = join(getPaths().userDataDir, "apply-update.sh");
  writeFileSync(scriptPath, script);
  chmodSync(scriptPath, 0o755);
  const child = spawn("/bin/bash", [scriptPath], { detached: true, stdio: "ignore" });
  child.unref();
}
