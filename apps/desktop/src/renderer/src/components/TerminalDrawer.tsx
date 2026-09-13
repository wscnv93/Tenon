import { useEffect, useRef, useState } from "react";
import { useAtomValue } from "jotai";
import { Terminal } from "@xterm/xterm";
import type { ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { activeProjectAtom } from "../state";
import "@xterm/xterm/css/xterm.css";

type ResolvedTheme = "dark" | "light";

function currentTheme(): ResolvedTheme {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

const TERM_PALETTE: Record<ResolvedTheme, ITheme> = {
  dark: {
    background: "#131419",
    foreground: "#e8eaed",
    cursor: "#4db695",
    cursorAccent: "#131419",
    selectionBackground: "rgba(77, 182, 149, 0.25)",
    black: "#20242b",
    brightBlack: "#6a7381",
    green: "#4db695",
    cyan: "#6ac2d8",
    red: "#e2685c",
    yellow: "#e8b84b",
  },
  light: {
    background: "#f4f5f2",
    foreground: "#21242a",
    cursor: "#237a62",
    cursorAccent: "#f4f5f2",
    selectionBackground: "rgba(35, 122, 98, 0.22)",
    black: "#3a3f46",
    brightBlack: "#8a9099",
    green: "#237a62",
    cyan: "#1c6d8c",
    red: "#c24134",
    yellow: "#8f661c",
  },
};

/**
 * Built-in terminal: one PTY per project in a collapsible bottom drawer.
 * Created lazily on first open; survives pane toggles, resets per project.
 */
export function TerminalDrawer() {
  const project = useAtomValue(activeProjectAtom);
  const [open, setOpen] = useState(false);
  const [termId, setTermId] = useState<string | null>(null);
  const [theme, setTheme] = useState<ResolvedTheme>(currentTheme);
  const hostRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const termIdRef = useRef<string | null>(null);

  termIdRef.current = termId;

  // Follow the app theme (App sets data-theme on <html>).
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(currentTheme()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const term = xtermRef.current;
    if (term) term.options.theme = TERM_PALETTE[theme];
  }, [theme]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && (event.key === "j" || event.key === "J")) {
        event.preventDefault();
        setOpen((value) => !value);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Reset per project: dispose the old PTY and start fresh.
  useEffect(() => {
    setTermId((prev) => {
      if (prev) void window.tenon.invoke("terminal:dispose", { id: prev });
      return null;
    });
    xtermRef.current?.clear();
    setOpen(false);
  }, [project?.path]);

  useEffect(() => {
    if (!open || !project || !hostRef.current || xtermRef.current) return;
    const term = new Terminal({
      fontFamily: "ui-monospace, 'SF Mono', Menlo, monospace",
      fontSize: 12,
      cursorBlink: true,
      theme: TERM_PALETTE[currentTheme()],
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current);
    xtermRef.current = term;
    fitRef.current = fit;

    const fitNow = (): void => {
      try {
        fit.fit();
      } catch {
        // Pane too small mid-transition.
      }
    };
    fitNow();

    void (async () => {
      const result = (await window.tenon.invoke("terminal:create", {
        projectPath: project.path,
        cols: term.cols,
        rows: term.rows,
      })) as { id: string };
      setTermId(result.id);
    })();

    const unsubscribe = window.tenon.onTerminal((payload) => {
      if (payload.id !== termIdRef.current) return;
      if (payload.data) term.write(payload.data);
      if (payload.exited) term.write("\r\n\x1b[2m[进程已退出]\x1b[0m\r\n");
    });
    const observer = new ResizeObserver(fitNow);
    observer.observe(hostRef.current);
    term.onData((data) => {
      if (termIdRef.current) void window.tenon.invoke("terminal:input", { id: termIdRef.current, data });
    });
    term.onResize(({ cols, rows }) => {
      if (termIdRef.current) void window.tenon.invoke("terminal:resize", { id: termIdRef.current, cols, rows });
    });

    return () => {
      unsubscribe();
      observer.disconnect();
      if (termIdRef.current) void window.tenon.invoke("terminal:dispose", { id: termIdRef.current });
      termIdRef.current = null;
      setTermId(null);
      term.dispose();
      xtermRef.current = null;
    };
  }, [open, project?.path]);

  useEffect(() => {
    if (open) setTimeout(() => fitRef.current?.fit(), 200);
  }, [open]);

  return (
    <div className={`term-drawer ${open ? "open" : ""}`}>
      <div className="term-drawer-head">
        <button type="button" className="chip" onClick={() => setOpen(!open)}>
          终端 {open ? "▾" : "▴"}
        </button>
        <span className="term-drawer-meta">{project?.name ?? ""}</span>
        {open && (
          <button
            type="button"
            className="link"
            onClick={() => {
              if (termId) void window.tenon.invoke("terminal:dispose", { id: termId });
              setTermId(null);
              xtermRef.current?.clear();
              // Recreate immediately with the existing xterm instance.
              if (project && xtermRef.current) {
                void window.tenon.invoke("terminal:create", {
                  projectPath: project.path,
                  cols: xtermRef.current.cols,
                  rows: xtermRef.current.rows,
                }).then((result) => setTermId((result as { id: string }).id));
              }
            }}
          >
            重启 shell
          </button>
        )}
      </div>
      <div className="term-drawer-body" ref={hostRef} />
    </div>
  );
}
