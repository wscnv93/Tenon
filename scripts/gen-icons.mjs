#!/usr/bin/env node
/** Renders app icons from resources/logo.svg via resvg. */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const desktopDir = join(root, "apps", "desktop");
// resvg is a devDependency of apps/desktop; resolve from there.
const { Resvg } = createRequire(join(desktopDir, "package.json"))("@resvg/resvg-js");
const svg = readFileSync(join(desktopDir, "resources", "logo.svg"), "utf8");
mkdirSync(join(desktopDir, "build"), { recursive: true });
for (const size of [32, 128, 256, 512, 1024]) {
  const png = new Resvg(svg, { fitTo: { mode: "width", value: size } }).render().asPng();
  const target = join(desktopDir, "build", size === 1024 ? "icon.png" : `icon-${size}.png`);
  writeFileSync(target, png);
  console.log("wrote", target);
}
