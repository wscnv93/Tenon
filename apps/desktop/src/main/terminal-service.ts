/**
 * Per-project PTY sessions backing the built-in terminal (⌘J).
 *
 * Data flows over a dedicated high-frequency push channel; input/resize
 * go through invoke. One shell per project, disposed on app quit.
 */
import { spawn } from "node-pty";
import type { IPty } from "node-pty";
import type { BrowserWindow } from "electron";

export const TERMINAL_EVENT_CHANNEL = "tenon:terminal";

interface TermSession {
  pty: IPty;
  projectPath: string;
}

export class TerminalService {
  private sessions = new Map<string, TermSession>();
  private window: () => BrowserWindow | null;

  constructor(getWindow: () => BrowserWindow | null) {
    this.window = getWindow;
  }

  create(projectPath: string, cols: number, rows: number): string {
    // One terminal per project: reuse when it already exists.
    for (const [id, session] of this.sessions) {
      if (session.projectPath === projectPath) return id;
    }
    const id = `term_${Date.now().toString(36)}`;
    const shell = process.env.SHELL || "/bin/zsh";
    const pty = spawn(shell, ["-l"], {
      name: "xterm-256color",
      cols,
      rows,
      cwd: projectPath,
      env: { ...process.env, TERM: "xterm-256color" } as Record<string, string>,
    });
    this.sessions.set(id, { pty, projectPath });
    pty.onData((data) => {
      this.window()?.webContents.send(TERMINAL_EVENT_CHANNEL, { id, data });
    });
    pty.onExit(({ exitCode }) => {
      this.window()?.webContents.send(TERMINAL_EVENT_CHANNEL, { id, exited: true, exitCode });
      this.sessions.delete(id);
    });
    return id;
  }

  input(id: string, data: string): void {
    this.sessions.get(id)?.pty.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    try {
      this.sessions.get(id)?.pty.resize(cols, rows);
    } catch {
      // Resize races with exit — ignore.
    }
  }

  dispose(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);
    try {
      session.pty.kill();
    } catch {
      // Already gone.
    }
  }

  disposeProject(projectPath: string): void {
    for (const [id, session] of [...this.sessions]) {
      if (session.projectPath === projectPath) this.dispose(id);
    }
  }

  disposeAll(): void {
    for (const [id] of [...this.sessions]) this.dispose(id);
  }
}
