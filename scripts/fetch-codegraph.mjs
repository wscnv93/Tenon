#!/usr/bin/env node
/**
 * Vendors the colbymchenry/codegraph platform bundle (self-contained:
 * launcher + Node runtime + grammars) into apps/desktop/vendor/codegraph.
 *
 * Source: the optionalDependency @colbymchenry/codegraph-<platform>-<arch>
 * installed alongside @colbymchenry/codegraph in packages/pi-extensions.
 * Skipped on platforms without a matching bundle — the extension then falls
 * back to `codegraph` on PATH or its npm shim.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const vendorDir = join(root, "apps", "desktop", "vendor");
const target = `codegraph-${process.platform}-${process.arch}`;

if (process.platform === "win32") {
  console.log("fetch-codegraph: windows vendoring not wired yet; extension falls back to PATH");
  process.exit(0);
}

const extensionsDir = join(root, "packages", "pi-extensions");
const require = createRequire(join(extensionsDir, "package.json"));

let source;
try {
  const pkgPath = require.resolve(`@colbymchenry/codegraph/package.json`);
  const version = require(pkgPath).version;
  // pnpm keeps the optional dep as a sibling of the main package in .pnpm.
  const candidates = [
    join(dirname(pkgPath), "..", target),
    join(extensionsDir, "node_modules", "@colbymchenry", target),
  ];
  for (const candidate of candidates) {
    const launcher = join(candidate, "bin", "codegraph");
    if (existsSync(launcher)) {
      source = { dir: candidate, version };
      break;
    }
  }
  if (!source) {
    // Last resort: scan the .pnpm store.
    const pnpmDir = join(root, "node_modules", ".pnpm");
    if (existsSync(pnpmDir)) {
      for (const entry of readdirSync(pnpmDir)) {
        if (!entry.startsWith(`@colbymchenry+${target}@`)) continue;
        const candidate = join(
          pnpmDir,
          entry,
          "node_modules",
          "@colbymchenry",
          target,
        );
        if (existsSync(join(candidate, "bin", "codegraph"))) {
          source = { dir: candidate, version: entry.split("@").pop() ?? "unknown" };
          break;
        }
      }
    }
  }
} catch (error) {
  console.log(`fetch-codegraph: resolution failed: ${error.message}`);
}

if (!source) {
  console.log("fetch-codegraph: platform bundle not found; extension falls back to PATH/shim");
  process.exit(0);
}

const dest = join(vendorDir, "codegraph");
const marker = join(vendorDir, `codegraph-${process.platform}-${process.arch}.version`);
if (existsSync(marker)) {
  const { readFileSync } = await import("node:fs");
  if (readFileSync(marker, "utf-8").trim() === source.version && existsSync(join(dest, "bin", "codegraph"))) {
    console.log(`fetch-codegraph: ${source.version} already vendored`);
    process.exit(0);
  }
}

rmSync(dest, { force: true, recursive: true });
mkdirSync(vendorDir, { recursive: true });
cpSync(source.dir, dest, { recursive: true });
writeFileSync(marker, `${source.version}\n`);
console.log(`fetch-codegraph: vendored ${target} ${source.version} (${dest})`);
