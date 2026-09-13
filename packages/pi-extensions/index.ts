/**
 * Tenon extension bundle loaded inside the pi process.
 *
 * Composes:
 * - gate: execution modes, OS sandbox for bash, approval dialogs
 * - codegraph: tree-sitter symbol/call index + four query tools
 */
import { join } from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { setupGate } from "./gate.js";
import { CodeIndex, projectStorePath } from "./codegraph/indexer.js";
import { setupCodegraphTools } from "./codegraph/tools.js";

function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

let codeIndex: CodeIndex | null = null;
let indexStarted = false;

export default function (pi: ExtensionAPI) {
  setupGate(pi);
  setupCodegraphTools(pi, () => codeIndex);

  pi.on("session_start", async (_event, ctx) => {
    if (indexStarted) return;
    indexStarted = true;
    const index = new CodeIndex(ctx.cwd, projectStorePath(agentDir(), ctx.cwd), (done, total) => {
      if (total > 0 && (done === total || done % 200 === 0)) {
        ctx.ui.setStatus("tenon-index", done === total ? `代码索引:完成(${total} 文件)` : `代码索引:${done}/${total}`);
      }
    });
    void index
      .initialize()
      .then((result) => {
        codeIndex = index;
        ctx.ui.notify(
          result.reused
            ? `代码索引已就绪(复用缓存:${result.files} 文件,${result.symbols} 符号)`
            : `代码索引已就绪(${result.files} 文件,${result.symbols} 符号)`,
          "info",
        );
      })
      .catch(() => {
        // Indexing is optional; tools report "not ready" if it never completes.
      });
  });

  pi.on("session_shutdown", () => {
    codeIndex?.dispose();
    codeIndex = null;
    indexStarted = false;
  });
}
