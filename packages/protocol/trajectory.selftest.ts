// Round-trip against a real Tenon session JSONL.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseSessionEntries } from "@earendil-works/pi-coding-agent";
import { buildTrajectory } from "./src/trajectory.ts";

const dir = join(process.env.HOME!, "Library", "Application Support", "Tenon", "sessions");
const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort();
if (files.length === 0) { console.log("no sessions found"); process.exit(0); }
const file = join(dir, files.at(-1)!);
console.log("session:", files.at(-1));

const raw = parseSessionEntries(readFileSync(file, "utf-8"));
const entries = raw.filter((e) => e.type !== "session") as never[];
const leafId = (entries.at(-1) as { id: string }).id;
const view = buildTrajectory(entries, leafId);

console.log(`entries: ${entries.length} | turns: ${view.totals.turns} | tokens: ${view.totals.tokens} | cost: $${view.totals.cost.toFixed(4)} | abandoned: ${view.totals.abandoned}`);
for (const turn of view.turns) {
  console.log(`  [${turn.active ? "✓" : "x"}] ${turn.label.slice(0, 40).replace(/\n/g, " ")} | ${turn.durationMs}ms | ${turn.tokens}tk | tools=${turn.toolCalls} | steps=${turn.steps.map((s) => s.kind[0]).join("")}`);
}
console.log("TRAJ-SELFTEST-OK");
