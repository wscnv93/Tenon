/**
 * Tenon extension bundle loaded inside the pi process.
 *
 * Composes:
 * - gate: execution modes, OS sandbox for bash, approval dialogs
 * - review: run_tests / self_review dev loop
 * - codegraph-tools: semantic code intelligence via colbymchenry/codegraph CLI
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { setupGate } from "./gate.js";
import { setupReview } from "./review.js";
import { setupCodegraphTools } from "./codegraph-tools.js";

export default function (pi: ExtensionAPI) {
  setupGate(pi);
  setupReview(pi);
  setupCodegraphTools(pi);
}
