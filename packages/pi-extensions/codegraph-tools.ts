/**
 * Tenon codegraph tools — powered by colbymchenry/codegraph
 * (https://github.com/colbymchenry/codegraph, MIT).
 *
 * The extension shells out to the self-contained `codegraph` CLI (it bundles
 * its own Node runtime, so no ABI/runtime concerns inside the pi binary).
 * Lifecycle: on session start we ensure the project graph exists
 * (`codegraph init` when missing, `codegraph sync` when stale) in the
 * background; tools answer with clean guidance while that runs.
 */
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";

interface CodegraphBin {
  command: string;
  prefixArgs: string[];
}

let resolving: Promise<CodegraphBin | null> | null = null;

/**
 * Resolution order: TENON_CODEGRAPH_BIN → `codegraph` on PATH → the npm
 * package's launcher shim (dev installs; runs fine under the pi runtime).
 */
function resolveBin(): Promise<CodegraphBin | null> {
  if (resolving) return resolving;
  resolving = new Promise((resolve) => {
    const override = process.env.TENON_CODEGRAPH_BIN;
    if (override && existsSync(override)) {
      resolve({ command: override, prefixArgs: [] });
      return;
    }
    // PATH probe.
    execFile("codegraph", ["version"], { timeout: 15_000 }, (error) => {
      if (!error) {
        resolve({ command: "codegraph", prefixArgs: [] });
        return;
      }
      // Dev: the npm package launcher next to this extension.
      const shim = join(import.meta.dirname ?? ".", "node_modules", "@colbymchenry", "codegraph", "npm-shim.js");
      if (existsSync(shim)) {
        resolve({ command: process.execPath, prefixArgs: [shim] });
        return;
      }
      resolve(null);
    });
  });
  return resolving;
}

function run(
  bin: CodegraphBin,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    execFile(
      bin.command,
      [...bin.prefixArgs, ...args],
      { cwd, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = error && typeof (error as { code?: number }).code === "number" ? (error as { code: number }).code : error ? 1 : 0;
        resolve({ code, output: `${stdout}\n${stderr}`.trim() });
      },
    );
  });
}

function truncate(text: string, max = 12_000): string {
  return text.length > max ? `…(truncated)\n${text.slice(-max)}` : text;
}

const READY_HINT =
  "代码图谱尚未就绪:正在后台建图,稍后重试;若持续失败,请在项目中运行 codegraph init。";

export function setupCodegraphTools(pi: ExtensionAPI) {
  let indexing = false;

  interface UiLike {
    notify: (text: string, kind?: "info" | "warning" | "error") => void;
    setStatus: (key: string, text?: string) => void;
  }

  const ensureGraph = async (cwd: string, ui: UiLike): Promise<void> => {
    if (indexing) return;
    const bin = await resolveBin();
    if (!bin) {
      ui.notify("未找到 codegraph CLI — 符号图谱工具不可用(可设置 TENON_CODEGRAPH_BIN 指向可执行文件)", "warning");
      return;
    }
    if (existsSync(join(cwd, ".codegraph"))) {
      // Stale-ness sync is cheap; failures here are non-fatal.
      void run(bin, ["sync"], cwd, 120_000).then(({ code, output }) => {
        if (code === 0) ui.setStatus("codegraph", "代码图谱:已同步");
      });
      return;
    }
    indexing = true;
    ui.setStatus("codegraph", "代码图谱:后台建图中…");
    const child = spawn(bin.command, [...bin.prefixArgs, "init", cwd], {
      cwd,
      detached: true,
      stdio: "ignore",
    });
    child.on("error", () => {
      indexing = false;
      ui.setStatus("codegraph");
      ui.notify("codegraph init 启动失败", "error");
    });
    child.on("exit", (code) => {
      indexing = false;
      if (code === 0) {
        ui.setStatus("codegraph", "代码图谱:就绪");
        ui.notify("代码图谱已建好,codegraph_* 工具可用了", "info");
      } else {
        ui.setStatus("codegraph");
        ui.notify(`代码图谱建图失败(exit ${code})`, "error");
      }
    });
  };

  pi.on("session_start", async (_event, ctx) => {
    void ensureGraph(ctx.cwd, ctx.ui);
  });

  // ---------------------------------------------------------------------
  // Explore: the raw CLI output carries a lot of verbatim source, which
  // would flood the main session's context (upstream guidance). So:
  //   - main session: the tool dispatches an exploration SUBAGENT (a child
  //     pi --mode json -p run, tools restricted to codegraph_*) that digests
  //     the raw material and returns a bounded synthesis; TENON_SUBAGENT=1
  //     marks the child so it cannot recurse.
  //   - inside the subagent: the same tool name returns the raw CLI output
  //     (capped) — the subagent is exactly the consumer that wants it.
  // ---------------------------------------------------------------------
  const isSubagent = process.env.TENON_SUBAGENT === "1";

  const directExplore = async (ctx: { cwd: string; ui: UiLike }, query: string, cap: number): Promise<AgentToolResult<unknown>> => {
    const bin = await resolveBin();
    if (!bin) return { content: [{ type: "text", text: "未找到 codegraph CLI。" }], details: {} };
    if (!existsSync(join(ctx.cwd, ".codegraph"))) {
      void ensureGraph(ctx.cwd, ctx.ui);
      return { content: [{ type: "text", text: READY_HINT }], details: {} };
    }
    const { code, output } = await run(bin, ["explore", query], ctx.cwd, 90_000);
    return {
      content: [{ type: "text", text: code === 0 ? truncate(output, cap) : `codegraph explore 失败:\n${truncate(output, 3000)}` }],
      details: { ok: code === 0 },
    };
  };

  const getPiInvocation = (args: string[]): { command: string; args: string[] } => {
    const currentScript = process.argv[1];
    const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
    if (currentScript && !isBunVirtualScript && existsSync(currentScript)) {
      return { command: process.execPath, args: [currentScript, ...args] };
    }
    const execName = process.execPath.split("/").pop()?.toLowerCase() ?? "";
    const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
    if (!isGenericRuntime) return { command: process.execPath, args };
    return { command: "pi", args };
  };

  const EXPLORE_SYSTEM_PROMPT = `你是代码探索子代理。你的唯一职责:用 codegraph_* 工具(codegraph_explore / codegraph_search / codegraph_callers / codegraph_callees)回答给定的代码问题,然后输出一份紧凑的综合结论。

输出格式(总长不超过 40 行):
1. 结论 — 直接回答问题(2-5 句)
2. 关键位置 — file:line 列表(每项一行,附一句话说明)
3. 调用路径 — 与问题相关的调用链(如有)
4. 影响面 — 修改相关符号需要验证什么(如有)

硬性规则:禁止粘贴超过 3 行的源码片段;不要罗列完整文件;所有事实必须有 file:line 依据;探索完成即输出结论,不要请求用户输入。`;

  const dispatchExploreSubagent = async (
    ctx: { cwd: string },
    query: string,
    signal: AbortSignal | undefined,
    onUpdate?: (text: string) => void,
  ): Promise<{ ok: boolean; text: string }> => {
    const tmpDir = mkdtempSync(join(tmpdir(), "tenon-explore-"));
    const promptPath = join(tmpDir, "system.md");
    writeFileSync(promptPath, EXPLORE_SYSTEM_PROMPT);
    const args = [
      "--mode",
      "json",
      "-p",
      "--no-session",
      "--tools",
      "codegraph_explore,codegraph_search,codegraph_callers,codegraph_callees,read",
      "--append-system-prompt",
      promptPath,
      `Task: ${query}`,
    ];
    try {
      const invocation = getPiInvocation(args);
      const child = spawn(invocation.command, invocation.args, {
        cwd: ctx.cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, TENON_SUBAGENT: "1" },
      });
      let buffer = "";
      let lastText = "";
      let stderr = "";
      const timer = setTimeout(() => child.kill("SIGKILL"), 180_000);
      const onAbort = () => child.kill("SIGTERM");
      signal?.addEventListener("abort", onAbort, { once: true });

      const done = new Promise<string>((resolve) => {
        child.stdout.setEncoding("utf-8");
        child.stdout.on("data", (chunk: string) => {
          buffer += chunk;
          let index: number;
          while ((index = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, index);
            buffer = buffer.slice(index + 1);
            if (!line.trim()) continue;
            try {
              const event = JSON.parse(line) as { type: string; message?: { role: string; content?: unknown; stopReason?: string } };
              if (event.type === "message_end" && event.message?.role === "assistant") {
                const content = event.message.content;
                const text = typeof content === "string"
                  ? content
                  : Array.isArray(content)
                    ? content.filter((block: { type?: string }) => block?.type === "text").map((block: { text?: string }) => block.text ?? "").join("")
                    : "";
                if (text.trim()) {
                  lastText = text;
                  onUpdate?.(text);
                }
              }
            } catch {
              // Non-JSON line — ignore.
            }
          }
        });
        child.stderr.setEncoding("utf-8");
        child.stderr.on("data", (chunk: string) => (stderr += chunk));
        child.on("error", () => resolve(lastText || `子代理启动失败:${stderr.slice(-500)}`));
        child.on("close", (code) => {
          resolve(lastText || (code === 0 ? "" : `子代理异常退出(code ${code})${stderr ? `:${stderr.slice(-500)}` : ""}`));
        });
      });
      const text = await done;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      return { ok: Boolean(text), text: text || "子代理没有产出结论,请改用 codegraph_search/callers/callees 直接查询。" };
    } finally {
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // Best effort.
      }
    }
  };

  pi.registerTool({
    name: "codegraph_explore",
    label: isSubagent ? "语义探索(原始输出)" : "语义探索(推荐,派生子代理)",
    description: isSubagent
      ? "直接返回 codegraph explore 的原始输出(源码+调用路径+影响面)。你处于探索子代理内,请消化这些材料后输出紧凑结论。"
      : "回答宽泛的代码问题(how does X work、调用链、区域概览)。" +
        "本工具会派生一个探索子代理使用 codegraph 图谱深挖,并只返回紧凑结论(关键 file:line + 调用路径 + 影响面)," +
        "不会让大段源码占据主对话上下文。快速精确查找请改用 codegraph_search / codegraph_callers / codegraph_callees。",
    parameters: Type.Object({
      query: Type.String({ description: "自然语言问题、符号名或文件路径,如 'update flow'、'AuthService'" }),
    }),
    async execute(_id, params, signal, onUpdate, ctx): Promise<AgentToolResult<unknown>> {
      if (!existsSync(join(ctx.cwd, ".codegraph"))) {
        void ensureGraph(ctx.cwd, ctx.ui);
        return { content: [{ type: "text", text: READY_HINT }], details: {} };
      }
      if (isSubagent) {
        return await directExplore(ctx, params.query, 8000);
      }
      onUpdate?.({
        content: [{ type: "text", text: "已派出探索子代理,正在深挖并提炼结论…" }],
        details: {},
      });
      const result = await dispatchExploreSubagent(ctx, params.query, signal, (partial) => {
        onUpdate?.({ content: [{ type: "text", text: truncate(partial, 2000) }], details: {} });
      });
      return {
        content: [{ type: "text", text: result.ok ? truncate(result.text, 6000) : result.text }],
        details: { via: "subagent" },
      };
    },
  });

  pi.registerTool({
    name: "codegraph_search",
    label: "搜索符号",
    description: "在项目语义图谱中按名称搜索符号(函数/类/方法/接口),支持 --kind 过滤语义。比 grep 更准。",
    parameters: Type.Object({
      query: Type.String({ description: "名称或子串" }),
      limit: Type.Optional(Type.Number({ description: "返回条数上限,默认 20" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const bin = await resolveBin();
      if (!bin) return { content: [{ type: "text", text: "未找到 codegraph CLI。" }], details: {} };
      if (!existsSync(join(ctx.cwd, ".codegraph"))) {
        void ensureGraph(ctx.cwd, ctx.ui);
        return { content: [{ type: "text", text: READY_HINT }], details: {} };
      }
      const args = ["query", params.query, "--json", "--limit", String(params.limit ?? 20)];
      const { code, output } = await run(bin, args, ctx.cwd, 60_000);
      if (code !== 0) {
        return { content: [{ type: "text", text: `codegraph query 失败:\n${truncate(output, 3000)}` }], details: {} };
      }
      try {
        const parsed = JSON.parse(output) as Array<{
          node: { name: string; kind: string; filePath: string; startLine: number; signature?: string };
        }>;
        const text = parsed.length
          ? parsed
              .map((hit) => `${hit.node.filePath}:${hit.node.startLine} — ${hit.node.kind} ${hit.node.name}${hit.node.signature ? ` · ${hit.node.signature.split("\n")[0]}` : ""}`)
              .join("\n")
          : `没有符号匹配「${params.query}」。`;
        return { content: [{ type: "text", text }], details: { count: parsed.length } };
      } catch {
        return { content: [{ type: "text", text: truncate(output) }], details: {} };
      }
    },
  });

  pi.registerTool({
    name: "codegraph_callers",
    label: "查找调用方",
    description: "查找项目中哪些代码调用了指定函数/方法(含所在文件与行号)。",
    parameters: Type.Object({
      symbol: Type.String({ description: "函数/方法名" }),
      limit: Type.Optional(Type.Number({ description: "返回条数上限,默认 30" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const bin = await resolveBin();
      if (!bin) return { content: [{ type: "text", text: "未找到 codegraph CLI。" }], details: {} };
      if (!existsSync(join(ctx.cwd, ".codegraph"))) {
        void ensureGraph(ctx.cwd, ctx.ui);
        return { content: [{ type: "text", text: READY_HINT }], details: {} };
      }
      const args = ["callers", params.symbol, "--json", "--limit", String(params.limit ?? 30)];
      const { code, output } = await run(bin, args, ctx.cwd, 60_000);
      if (code !== 0) {
        return { content: [{ type: "text", text: `codegraph callers 失败:\n${truncate(output, 3000)}` }], details: {} };
      }
      try {
        const parsed = JSON.parse(output) as {
          symbol: string;
          callers: Array<{ name: string; filePath?: string; line?: number }>;
        };
        const text = parsed.callers?.length
          ? parsed.callers
              .map((caller) => `${caller.filePath ?? "?"}${caller.line != null ? `:${caller.line}` : ""} — ${caller.name}`)
              .join("\n")
          : `项目内没有对「${params.symbol}」的调用(可能是导出 API)。`;
        return { content: [{ type: "text", text }], details: { count: parsed.callers?.length ?? 0 } };
      } catch {
        return { content: [{ type: "text", text: truncate(output) }], details: {} };
      }
    },
  });

  pi.registerTool({
    name: "codegraph_callees",
    label: "查找被调用项",
    description: "列出指定函数/方法内部调用了哪些其他函数/方法。",
    parameters: Type.Object({
      symbol: Type.String({ description: "函数/方法名" }),
      limit: Type.Optional(Type.Number({ description: "返回条数上限,默认 30" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const bin = await resolveBin();
      if (!bin) return { content: [{ type: "text", text: "未找到 codegraph CLI。" }], details: {} };
      if (!existsSync(join(ctx.cwd, ".codegraph"))) {
        void ensureGraph(ctx.cwd, ctx.ui);
        return { content: [{ type: "text", text: READY_HINT }], details: {} };
      }
      const args = ["callees", params.symbol, "--json", "--limit", String(params.limit ?? 30)];
      const { code, output } = await run(bin, args, ctx.cwd, 60_000);
      if (code !== 0) {
        return { content: [{ type: "text", text: `codegraph callees 失败:\n${truncate(output, 3000)}` }], details: {} };
      }
      try {
        const parsed = JSON.parse(output) as {
          symbol: string;
          callees: Array<{ name: string; filePath?: string; line?: number }>;
        };
        const text = parsed.callees?.length
          ? parsed.callees
              .map((callee) => `${callee.filePath ?? "?"}${callee.line != null ? `:${callee.line}` : ""} — ${callee.name}`)
              .join("\n")
          : `没有找到「${params.symbol}」的调用记录或该符号不存在。`;
        return { content: [{ type: "text", text }], details: { count: parsed.callees?.length ?? 0 } };
      } catch {
        return { content: [{ type: "text", text: truncate(output) }], details: {} };
      }
    },
  });

  pi.registerTool({
    name: "codegraph_impact",
    label: "影响面分析",
    description: "分析修改某个符号会影响哪些代码(调用链传播,含深度)。改动前评估爆炸半径,改动后确定要验证的范围。",
    parameters: Type.Object({
      symbol: Type.String({ description: "函数/方法/类名" }),
      depth: Type.Optional(Type.Number({ description: "传播深度,默认 3" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const bin = await resolveBin();
      if (!bin) return { content: [{ type: "text", text: "未找到 codegraph CLI。" }], details: {} };
      if (!existsSync(join(ctx.cwd, ".codegraph"))) {
        void ensureGraph(ctx.cwd, ctx.ui);
        return { content: [{ type: "text", text: READY_HINT }], details: {} };
      }
      const args = ["impact", params.symbol, "--json"];
      if (params.depth != null) args.push("--depth", String(params.depth));
      const { code, output } = await run(bin, args, ctx.cwd, 60_000);
      if (code !== 0) {
        return { content: [{ type: "text", text: `codegraph impact 失败:\n${truncate(output, 3000)}` }], details: {} };
      }
      return { content: [{ type: "text", text: truncate(output) }], details: {} };
    },
  });
}
