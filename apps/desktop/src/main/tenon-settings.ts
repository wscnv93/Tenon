import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { getPaths } from "./paths.js";
import type { TenonProject } from "@protocol/ipc";

export interface TenonSettings {
  projects: TenonProject[];
  activeProjectId: string | null;
}

const DEFAULTS: TenonSettings = { projects: [], activeProjectId: null };

let cache: TenonSettings | null = null;

export function loadSettings(): TenonSettings {
  if (cache) return cache;
  const file = getPaths().settingsFile;
  if (!existsSync(file)) {
    cache = { ...DEFAULTS };
    return cache;
  }
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as Partial<TenonSettings>;
    cache = {
      projects: Array.isArray(parsed.projects) ? parsed.projects : [],
      activeProjectId: parsed.activeProjectId ?? null,
    };
  } catch {
    cache = { ...DEFAULTS };
  }
  return cache;
}

export function saveSettings(settings: TenonSettings): void {
  cache = settings;
  writeFileSync(getPaths().settingsFile, JSON.stringify(settings, null, 2), { mode: 0o600 });
}

export function makeProject(projectPath: string): TenonProject {
  return {
    id: `proj_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    path: projectPath,
    name: basename(projectPath) || projectPath,
    addedAt: Date.now(),
  };
}

export function updateProject(id: string, patch: Partial<TenonProject>): void {
  const settings = loadSettings();
  const projects = settings.projects.map((project) => (project.id === id ? { ...project, ...patch } : project));
  saveSettings({ ...settings, projects });
}
