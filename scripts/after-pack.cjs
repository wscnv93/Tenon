/**
 * electron-builder afterPack: re-seal the app with an ad-hoc signature.
 *
 * electron-builder skipped signing (identity: null), leaving the linker-signed
 * main executable with a stale seal over a bundle we modified — macOS refuses
 * to launch apps whose signature doesn't match their contents. Ad-hoc signing
 * after packing satisfies Apple Silicon's mandatory-signature requirement and
 * reseals every modified resource.
 */
const { execSync } = require("node:child_process");
const path = require("node:path");

exports.default = async function afterPack(context) {
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const run = (cmd) => {
    console.log(`  • ${cmd}`);
    execSync(cmd, { stdio: "inherit" });
  };

  // Nested Mach-O we ship in Resources must be signed before the outer seal.
  const nested = execSync(
    `find "${appPath}/Contents/Resources/vendor" "${appPath}/Contents/Resources/tenon-gate" ` +
      `\\( -type f -perm +111 -o -name "*.node" \\) 2>/dev/null || true`,
    { shell: "/bin/bash" },
  )
    .toString()
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  for (const target of nested) {
    run(`codesign --force --sign - '${target}'`);
  }

  // Re-seal the whole bundle (helpers included).
  run(`codesign --force --deep --sign - '${appPath}'`);
  run(`codesign --verify --deep '${appPath}'`);
};
