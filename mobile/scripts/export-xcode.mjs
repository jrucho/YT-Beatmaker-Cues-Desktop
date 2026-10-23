// Export an openable, portable Xcode project with built web assets and local Swift plugin sources.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const mobile = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspace = resolve(mobile, "..");
const { version } = JSON.parse(readFileSync(join(mobile, "package.json"), "utf8"));
const release = join(workspace, "release");
const name = `Beatmaker-Cues-Xcode-${version}`;
const output = join(release, name);
const zip = `${output}.zip`;
const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");
const archive = (path) => {
  const hash = createHash("sha256").update(readFileSync(path)).digest("hex");
  const folder = join(release, "backups", `${stamp()}-ios-xcode-${hash.slice(0, 8)}`);
  mkdirSync(folder, { recursive: true });
  copyFileSync(path, join(folder, basename(path)));
  writeFileSync(join(folder, "SHA256SUMS.txt"), `${hash}  ${basename(path)}\n`);
  return hash;
};
if (!existsSync(join(mobile, "ios/App/App/public/index.html"))) throw new Error("Run pnpm --filter @musike/mobile build:ios first");
mkdirSync(release, { recursive: true });
if (existsSync(zip)) archive(zip);
const filter = (source) => !["xcuserdata", "build", ".build", ".DS_Store", "DerivedData"].includes(basename(source));
if (existsSync(output)) {
  // Preserve edits made directly in a previously exported Xcode project as well as its original ZIP.
  const previous = join(release, "backups", `${stamp()}-ios-xcode-project`, name);
  cpSync(output, previous, { recursive: true, filter });
}
rmSync(output, { recursive: true, force: true });
mkdirSync(output);
for (const directory of ["App", "App.xcodeproj", "CapApp-SPM"]) {
  cpSync(join(mobile, "ios/App", directory), join(output, directory), { recursive: true, filter });
}
copyFileSync(join(mobile, "ios/debug.xcconfig"), join(output, "debug.xcconfig"));
cpSync(join(mobile, "ios/Tests"), join(output, "Tests"), { recursive: true, filter });
const project = join(output, "App.xcodeproj/project.pbxproj");
writeFileSync(project, readFileSync(project, "utf8").replace("path = ../debug.xcconfig;", "path = debug.xcconfig;"));
const plugins = { CapacitorApp: "app", CapacitorFilesystem: "filesystem", CapacitorKeyboard: "keyboard", CapacitorShare: "share" };
const manifest = join(output, "CapApp-SPM/Package.swift");
let contents = readFileSync(manifest, "utf8");
for (const [packageName, plugin] of Object.entries(plugins)) {
  const source = join(mobile, "node_modules/@capacitor", plugin);
  const target = join(output, "Packages", packageName);
  mkdirSync(target, { recursive: true });
  for (const entry of ["Package.swift", "ios", "LICENSE", "README.md"]) {
    if (existsSync(join(source, entry))) cpSync(join(source, entry), join(target, entry), { recursive: true, dereference: true, filter });
  }
  const pattern = new RegExp(`\\.package\\(name: "${packageName}", path: "[^"]+"\\)`);
  if (!pattern.test(contents)) throw new Error(`Missing Swift package reference: ${packageName}`);
  contents = contents.replace(pattern, `.package(name: "${packageName}", path: "../Packages/${packageName}")`);
}
writeFileSync(manifest, contents);
copyFileSync(join(workspace, "docs/ios-xcode.md"), join(output, "README.md"));
const result = spawnSync("ditto", ["-c", "-k", "--keepParent", output, zip], { stdio: "inherit" });
if (result.status !== 0) throw new Error("Xcode ZIP export failed");
const hash = archive(zip);
writeFileSync(`${zip}.sha256`, `${hash}  ${basename(zip)}\n`);
console.log(`Xcode project: ${join(output, "App.xcodeproj")}\nZIP: ${zip}\nSHA-256: ${hash}`);
