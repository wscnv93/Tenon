/**
 * Agent-facing codegraph tools. Output is compact text (file:line references)
 * so tool results stay cheap in the LLM context.
 */
import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { CodeIndex } from "./indexer.js";

function formatRef(_index: CodeIndex, file: string, line: number, extra?: string): string {
  const relativePath = file.replace(/\\/g, "/");
  return `${relativePath}:${line}${extra ? ` — ${extra}` : ""}`;
}

export function setupCodegraphTools(pi: ExtensionAPI, getIndex: () => CodeIndex | null): void {
  pi.registerTool({
    name: "explore_symbol",
    label: "查找符号定义",
    description:
      "在项目代码索引中按名称查找函数/类/接口/类型等的定义位置。比 grep 更快更准。返回 file:line 列表。",
    parameters: Type.Object({
      name: Type.String({ description: "符号名称,如 parseUnifiedDiff" }),
    }),
    async execute(_id, params) {
      const index = getIndex();
      if (!index) return { content: [{ type: "text", text: "代码索引尚未就绪。" }], details: {} };
      const hits = index.lookupSymbol(params.name);
      if (hits.length === 0) {
        const fuzzy = index.searchSymbols(params.name, 10);
        const text = fuzzy.length
          ? `没有精确符号「${params.name}」。相近符号:\n${fuzzy
              .map((r) => formatRef(index, r.file, r.symbol.line, `${r.symbol.kind} ${r.symbol.name}`))
              .join("\n")}`
          : `没有找到符号「${params.name}」。`;
        return { content: [{ type: "text", text }], details: {} };
      }
      const text = hits
        .map((r) => formatRef(index, r.file, r.symbol.line, `${r.symbol.kind} ${r.symbol.name}`))
        .join("\n");
      return { content: [{ type: "text", text }], details: {} };
    },
  });

  pi.registerTool({
    name: "get_callers",
    label: "查找调用方",
    description: "查找项目内哪些地方调用了指定函数/方法。返回 file:line 与所在函数。",
    parameters: Type.Object({
      name: Type.String({ description: "被调用符号名称" }),
    }),
    async execute(_id, params) {
      const index = getIndex();
      if (!index) return { content: [{ type: "text", text: "代码索引尚未就绪。" }], details: {} };
      const callers = index.callersOf(params.name);
      const text = callers.length
        ? callers.map((c) => formatRef(index, c.file, c.line, c.caller ? `in ${c.caller}` : undefined)).join("\n")
        : `项目内没有对「${params.name}」的调用(或为导出 API/未索引语言)。`;
      return { content: [{ type: "text", text }], details: {} };
    },
  });

  pi.registerTool({
    name: "get_callees",
    label: "查找被调用项",
    description: "列出指定函数/方法内部调用了哪些其他函数/方法。",
    parameters: Type.Object({
      name: Type.String({ description: "函数/方法名称" }),
    }),
    async execute(_id, params) {
      const index = getIndex();
      if (!index) return { content: [{ type: "text", text: "代码索引尚未就绪。" }], details: {} };
      const callees = index.calleesOf(params.name);
      const text = callees.length
        ? callees.map((c) => formatRef(index, c.file, c.line, c.callee)).join("\n")
        : `没有找到「${params.name}」内部的调用,或该符号不存在。`;
      return { content: [{ type: "text", text }], details: {} };
    },
  });

  pi.registerTool({
    name: "search_code",
    label: "搜索代码符号",
    description: "按子串模糊搜索项目内所有已索引符号(函数/类/方法/类型)。适用于记得大概名称时快速定位。",
    parameters: Type.Object({
      query: Type.String({ description: "名称子串,如 UnifiedDiff" }),
    }),
    async execute(_id, params) {
      const index = getIndex();
      if (!index) return { content: [{ type: "text", text: "代码索引尚未就绪。" }], details: {} };
      const hits = index.searchSymbols(params.query, 30);
      const text = hits.length
        ? hits.map((r) => formatRef(index, r.file, r.symbol.line, `${r.symbol.kind} ${r.symbol.name}`)).join("\n")
        : `没有符号匹配「${params.query}」。`;
      return { content: [{ type: "text", text }], details: {} };
    },
  });
}
