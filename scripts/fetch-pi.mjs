#!/usr/bin/env node
/**
 * Downloads the pinned pi standalone binary for this platform into
 * apps/desktop/vendor/. The binary is the engine sidecar: a Bun-compiled
 * single file with no Node/Electron dependency, so spawning it never touches
 * LaunchServices (no Dock bounce) and users need no runtime installed.
 *
 * Runs on postinstall; set TENON_SKIP_PI_FETCH=1 to skip (e.g. offline CI).
 */
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const PI_VERSION = "0.85.1";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const vendorDir = join(root, "apps", "desktop", "vendor");
const platform = `${process.platform}-${process.arch}`;

const ASSET_NAMES = {
  "darwin-arm64": "pi-darwin-arm64.tar.gz",
  "darwin-x64": "pi-darwin-x64.tar.gz",
  "linux-arm64": "pi-linux-arm64.tar.gz",
  "linux-x64": "pi-linux-x64.tar.gz",
};

if (process.env.TENON_SKIP_PI_FETCH === "1") {
  console.log("fetch-pi: skipped (TENON_SKIP_PI_FETCH=1)");
  process.exit(0);
}
const asset = ASSET_NAMES[platform];
if (!asset) {
  console.log(`fetch-pi: no prebuilt binary for ${platform}; the app will fall back to the node_modules spawn`);
  process.exit(0);
}

const marker = join(vendorDir, `pi-${platform}.version`);
if (existsSync(marker) && readFileSync(marker, "utf-8").trim() === PI_VERSION) {
  console.log(`fetch-pi: ${PI_VERSION} already present`);
  process.exit(0);
}

mkdirSync(vendorDir, { recursive: true });
const tmpDir = join(vendorDir, `.tmp-${Date.now()}`);
mkdirSync(tmpDir, { recursive: true });

const base = `https://github.com/earendil-works/pi/releases/download/v${PI_VERSION}`;
console.log(`fetch-pi: downloading ${asset}...`);

const tarPath = join(tmpDir, asset);
try {
  // Unstable upstreams: force HTTP/1.1 and resume on partial transfers.
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      execFileSync(
        "curl",
        ["-fsSL", "--http1.1", "--retry", "3", "--retry-all-errors", "-C", "-", "-o", tarPath, `${base}/${asset}`],
        { stdio: "inherit" },
      );
      break;
    } catch (error) {
      if (attempt === 5) throw error;
      console.log(`fetch-pi: download attempt ${attempt} failed, resuming...`);
    }
  }

  const sums = execFileSync("curl", ["-fsSL", `${base}/SHA256SUMS`], { encoding: "utf-8" });
  const expected = sums
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .find(([hash, name]) => name === asset)?.[0];
  if (!expected) throw new Error(`SHA256SUMS has no entry for ${asset}`);
  const actual = createHash("sha256").update(readFileSync(tarPath)).digest("hex");
  if (actual !== expected) throw new Error(`SHA256 mismatch: expected ${expected}, got ${actual}`);
  console.log("fetch-pi: sha256 verified");

  execFileSync("tar", ["-xzf", tarPath, "-C", tmpDir], { stdio: "inherit" });
  // The archive extracts a `pi/` directory: the Bun-compiled binary plus the
  // assets it resolves next to itself (theme, export-html, wasm, docs).
  const extractedDir = join(tmpDir, "pi");
  const extractedBinary = join(extractedDir, "pi");
  if (!existsSync(extractedBinary)) throw new Error("archive did not contain a pi/pi binary");
  const target = join(vendorDir, `pi-${platform}`);
  rmSync(target, { force: true, recursive: true });
  execFileSync("mv", [extractedDir, target]);
  chmodSync(extractedBinary, 0o755);
  writeFileSync(marker, `${PI_VERSION}\n`);
  console.log(`fetch-pi: installed ${target}/pi`);
} finally {
  rmSync(tmpDir, { force: true, recursive: true });
}
