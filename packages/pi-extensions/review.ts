/**
 * Tenon review — the dev self-test/review loop as agent tools.
 *
 * run_tests: detects the project's test framework, runs it (sandboxed when
 * the execution mode asks for it), and returns a compact structured result
 * the model can act on to fix failures.
 *
 * self_review: collects the current uncommitted diff plus a fixed checklist
 * and hands the material back so the model reviews its own changes before
 * declaring a turn done.
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ensureSandbox, readMode } from "./gate.js";

const MAX_OUTPUT = 8000;
const TEST_TIMEOUT_SECONDS = 300;

interface Framework {
  name: string;
  command: string;
}

function detectFramework(cwd: string): Framework | null {
  const pkgPath = join(cwd, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
        scripts?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      if (pkg.scripts?.test && pkg.scripts.test !== "echo \"Error: no test specified\" && exit 0") {
        const runner = pkg.devDependencies?.vitest
          ? "vitest run"
          : pkg.devDependencies?.jest
            ? "jest"
            : undefined;
        return { name: runner ? `${runner} (package.json)` : "npm test", command: runner ?? "npm test" };
      }
      if (pkg.devDependencies?.vitest) return { name: "vitest", command: "vitest run" };
      if (pkg.devDependencies?.jest) return { name: "jest", command: "jest" };
    } catch {
      // Fall through to file-based detection.
    }
  }
  if (existsSync(join(cwd, "pytest.ini")) || existsSync(join(cwd, "pyproject.toml"))) {
    return { name: "pytest", command: "python3 -m pytest -q" };
  }
  if (existsSync(join(cwd, "go.mod"))) {
    return { name: "go test", command: "go test ./..." };
  }
  if (existsSync(join(cwd, "Cargo.toml"))) {
    return { name: "cargo test", command: "cargo test" };
  }
  return null;
}

function run(command: string, cwd: string, timeoutSec: number): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    execFile(
      "bash",
      ["-c", command],
      { cwd, timeout: timeoutSec * 1000, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const combined = `${stdout}\n${stderr}`.trim();
        const code =
          error && typeof (error as { code?: number }).code === "number"
            ? (error as { code: number }).code
            : error
              ? 1
              : 0;
        resolve({ code, output: combined });
      },
    );
  });
}

function tail(text: string, max = MAX_OUTPUT): string {
  return text.length > max ? `…(truncated)\n${text.slice(-max)}` : text;
}

export function setupReview(pi: ExtensionAPI) {
  pi.registerTool({
    name: "run_tests",
    label: "运行测试",
    description:
      "探测并运行当前项目的测试套件(vitest/jest/pytest/go test/cargo test),返回结构化的通过/失败结果。" +
      "完成代码修改后应主动调用以自测;失败时根据输出修复后重跑。受当前执行模式的沙箱约束。",
    parameters: Type.Object({
      command: Type.Optional(Type.String({ description: "覆盖自动探测,直接指定测试命令" })),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      void signal;
      const cwd = ctx.cwd;
      const framework = params.command ? { name: "custom", command: params.command } : detectFramework(cwd);
      if (!framework) {
        return {
          content: [
            {
              type: "text",
              text: "未探测到测试框架(检查了 package.json scripts、pytest、go.mod、Cargo.toml)。可为 run_tests 传入 command 参数显式指定。",
            },
          ],
          details: { passed: false, framework: null },
        };
      }

      onUpdate?.({ content: [{ type: "text", text: `${framework.name}: ${framework.command}` }], details: {} });

      const mode = readMode();
      let command = framework.command;
      if (mode !== "full") {
        try {
          await ensureSandbox(mode, cwd);
          command = await SandboxManager.wrapWithSandbox(command);
        } catch (err) {
          return {
            content: [
              { type: "text", text: `沙箱初始化失败(${err instanceof Error ? err.message : String(err)}),测试未运行。` },
            ],
            details: { passed: false, framework: framework.name },
          };
        }
      }

      const { code, output } = await run(command, cwd, TEST_TIMEOUT_SECONDS);
      const passed = code === 0;
      const summary = tail(output);
      const text = passed
        ? `✅ 测试通过(${framework.name},exit 0)\n${summary}`
        : `❌ 测试失败(${framework.name},exit ${code})\n${summary}\n\n请根据以上失败输出修复代码,然后再次调用 run_tests。`;
      return { content: [{ type: "text", text }], details: { passed, framework: framework.name, exitCode: code } };
    },
  });

  pi.registerTool({
    name: "self_review",
    label: "自检变更",
    description:
      "收集当前未提交改动的 diff 与自检清单,供你逐项核对后再收尾。完成实现后、宣告完成前应调用," +
      "并对清单逐项给出结论;发现问题直接修复并重跑 run_tests。",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;
      const { code, output } = await run("git diff HEAD --stat --no-color && git diff HEAD --no-color", cwd, 30);
      if (code !== 0 && !output.trim()) {
        return { content: [{ type: "text", text: "git diff 不可用(非仓库或无 HEAD)。" }], details: {} };
      }
      if (!output.trim()) {
        return { content: [{ type: "text", text: "当前没有未提交的改动。" }], details: {} };
      }
      const diff = tail(output, 12000);
      const checklist = [
        "1. 需求覆盖:diff 是否完整实现了本轮任务的要求?有无遗漏分支/边界?",
        "2. 正确性:逻辑、命名、类型是否正确?有没有临时调试代码、死代码、被注释掉的实现?",
        "3. 测试:改动是否有对应测试?是否已用 run_tests 验证通过?",
        "4. 安全性:是否引入注入/路径穿越/敏感信息(密钥、token)泄漏?",
        "5. 一致性:风格与项目既有约定是否一致?有无不必要的外观性改动混入?",
        "6. 影响面:是否破坏既有调用方?公开接口/导出是否需要同步更新?",
      ].join("\n");
      const text = `以下是当前未提交改动的 diff,请对照清单逐项自检,直接给出结论并修复发现的问题:\n\n${checklist}\n\n--- DIFF ---\n${diff}`;
      return { content: [{ type: "text", text }], details: { checklist: checklist.split("\n").length } };
    },
  });
}
