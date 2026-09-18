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
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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

  pi.registerTool({
    name: "codegraph_explore",
    label: "语义探索(推荐)",
    description:
      "一次调用回答绝大多数代码问题:how does X work、从 X 到 Y 的调用链、某个区域的概览。" +
      "返回相关符号的源码(按文件分组)、调用路径、影响面(blast radius)摘要。基于项目的 codegraph 语义图谱。",
    parameters: Type.Object({
      query: Type.String({ description: "自然语言问题、符号名或文件路径,如 'update flow'、'AuthService'" }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const bin = await resolveBin();
      if (!bin) return { content: [{ type: "text", text: "未找到 codegraph CLI。" }], details: {} };
      if (!existsSync(join(ctx.cwd, ".codegraph"))) {
        void ensureGraph(ctx.cwd, ctx.ui);
        return { content: [{ type: "text", text: READY_HINT }], details: {} };
      }
      const { code, output } = await run(bin, ["explore", params.query], ctx.cwd, 90_000);
      return {
        content: [{ type: "text", text: code === 0 ? truncate(output) : `codegraph explore 失败:\n${truncate(output, 3000)}` }],
        details: { ok: code === 0 },
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
