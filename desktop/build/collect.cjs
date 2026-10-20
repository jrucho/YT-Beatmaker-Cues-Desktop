// electron-builder hook (artifactBuildCompleted): copies each finished download to release/ at the repository root,
// named after the app, version, system and processor.
const { copyFileSync, mkdirSync } = require("node:fs");
const path = require("node:path");

const SYSTEMS = { win32: "Windows", darwin: "macOS", linux: "Linux" };
const ARCHS = ["ia32", "x64", "armv7l", "arm64", "universal"]; // electron-builder's Arch enum, in order
const DOWNLOADS = new Set([".exe", ".dmg", ".AppImage", ".deb"]);
const release = path.resolve(__dirname, "..", "..", "release");

module.exports = function collect(artifact) {
  const ext = path.extname(artifact.file);
  // Skip by-products such as blockmaps.
  if (!DOWNLOADS.has(ext) || artifact.file.includes("__uninstaller")) return;
  const system = SYSTEMS[artifact.packager.platform.nodeName];
  // Windows ships one build; macOS and Linux one per processor.
  const arch = system === "Windows" || artifact.arch == null ? "" : `-${ARCHS[artifact.arch]}`;
  const name = `YT-Beatmaker-Cues-Desktop-${artifact.packager.appInfo.version}-${system}${arch}${ext}`;
  mkdirSync(release, { recursive: true });
  copyFileSync(artifact.file, path.join(release, name));
  console.log(`  • collected       ${path.join("release", name)}`);
};
