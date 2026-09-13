import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getPaths } from "./paths.js";
import { PROVIDER_CATALOG, type ProviderCredentialStatus } from "@protocol/ipc";

/**
 * Minimal reader/writer for pi's auth.json credential store.
 *
 * Format (pi FileAuthStorageBackend): `{ "<provider>": { "type": "api_key", "key": "..." } | { "type": "oauth", ... } }`.
 * We preserve unknown entries and providers, only touching the entries the
 * user manages from the Tenon settings page.
 */
interface AuthEntry {
  type?: string;
  key?: string;
  [extra: string]: unknown;
}
type AuthFile = Record<string, AuthEntry>;

function authPath(): string {
  return join(getPaths().agentDir, "auth.json");
}

export function readAuthFile(): AuthFile {
  const file = authPath();
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as AuthFile;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeAuthFile(data: AuthFile): void {
  mkdirSync(getPaths().agentDir, { recursive: true });
  const file = authPath();
  writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    // Best effort on platforms that don't support the mode.
  }
}

export function setApiKey(provider: string, key: string): void {
  const trimmed = key.trim();
  if (!trimmed) throw new Error("API key must not be empty");
  const data = readAuthFile();
  data[provider] = { type: "api_key", key: trimmed };
  writeAuthFile(data);
}

export function removeCredential(provider: string): void {
  const data = readAuthFile();
  delete data[provider];
  writeAuthFile(data);
}

export function authStatus(): ProviderCredentialStatus[] {
  const data = readAuthFile();
  return PROVIDER_CATALOG.map(({ id }) => {
    const entry = data[id];
    if (!entry) {
      return { provider: id, type: "api_key" as const, configured: false };
    }
    if (entry.type === "oauth") {
      return { provider: id, type: "oauth" as const, configured: true };
    }
    if (typeof entry.key === "string" && entry.key.startsWith("!")) {
      return { provider: id, type: "shell_command" as const, configured: true };
    }
    if (typeof entry.key === "string" && entry.key.startsWith("$")) {
      return { provider: id, type: "env" as const, configured: true };
    }
    return { provider: id, type: "api_key" as const, configured: Boolean(entry.key) };
  });
}
