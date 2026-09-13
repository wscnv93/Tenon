// Standalone round-trip: index this repo, run queries, verify persistence.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodeIndex, projectStorePath } from "./indexer.js";

const repo = "/Users/wangshuai/Documents/ws/projects/codew/packages/pi-extensions";
const store = projectStorePath(mkdtempSync(join(tmpdir(), "cg-")), repo);
const t0 = Date.now();
const index = new CodeIndex(repo, store, (done, total) => {
  if (done % 100 === 0 || done === total) console.log(`  progress ${done}/${total}`);
});
const init = await index.initialize();
console.log(`indexed ${init.files} files, ${init.symbols} distinct symbols in ${Date.now() - t0}ms (reused=${init.reused})`);

const hits = index.lookupSymbol("CodeIndex");
console.log("explore CodeIndex:", hits.map((h) => `${h.file.split("/").pop()}:${h.symbol.line}(${h.symbol.kind})`).join(" "));

const callers = index.callersOf("setupCodegraphTools");
console.log("callers of setupCodegraphTools:", callers.map((c) => `${c.file.split("/").pop()}:${c.line} in ${c.caller}`).join(" | "));

const callees = index.calleesOf("initialize");
console.log("callees of initialize:", callees.slice(0, 6).map((c) => c.callee).join(", "));

const search = index.searchSymbols("enclosing", 5);
console.log("search 'enclosing':", search.map((s) => s.symbol.name).join(", "));

const t1 = Date.now();
const index2 = new CodeIndex(repo, store);
const init2 = await index2.initialize();
console.log(`second init: ${init2.files} files in ${Date.now() - t1}ms (reused=${init2.reused})`);
console.log(init2.reused && init2.files === init.files ? "SELFTEST-OK" : "SELFTEST-MISMATCH");
process.exit(0);
