// Immutable local APK archives, plus optional source changes against the recorded Git base.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const backups = join(workspace, "release", "backups");

export function archiveApk(apk, note, { snapshotSource = false } = {}) {
  const sha256 = createHash("sha256").update(readFileSync(apk)).digest("hex");
  mkdirSync(backups, { recursive: true });
  for (const entry of readdirSync(backups, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const metadata = join(backups, entry.name, "build.json");
    if (existsSync(metadata) && JSON.parse(readFileSync(metadata, "utf8")).sha256 === sha256) {
      const existing = join(backups, entry.name);
      console.log(`APK already archived: ${existing}`);
      return existing;
    }
  }
  const createdAt = new Date().toISOString();
  const directory = join(backups, `${createdAt.replace(/[:.]/g, "-")}-${sha256.slice(0, 8)}`);
  mkdirSync(directory);
  const name = basename(apk);
  copyFileSync(apk, join(directory, name));
  if (existsSync(`${apk}.idsig`)) copyFileSync(`${apk}.idsig`, join(directory, `${name}.idsig`));
  writeFileSync(join(directory, "SHA256SUMS.txt"), `${sha256}  ${name}\n`);
  const git = (...args) => spawnSync("git", args, { cwd: workspace, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  const base = snapshotSource ? git("rev-parse", "HEAD") : null;
  if (snapshotSource) {
    const diff = git("diff", "--binary", "HEAD");
    const untracked = git("ls-files", "--others", "--exclude-standard", "-z");
    if (base.status !== 0 || diff.status !== 0 || untracked.status !== 0) throw new Error("Could not snapshot source changes");
    writeFileSync(join(directory, "changes.patch"), diff.stdout);
    if (untracked.stdout) {
      const tar = spawnSync("tar", ["-czf", join(directory, "untracked-sources.tar.gz"), "--null", "-T", "-"], {
        cwd: workspace, input: untracked.stdout, encoding: "utf8",
      });
      if (tar.status !== 0) throw new Error(`Could not archive untracked source files: ${tar.stderr}`);
    }
  }
  writeFileSync(join(directory, "build.json"), JSON.stringify({
    createdAt, apk: name, sha256, note,
    sourceBaseCommit: base?.stdout.trim() ?? null,
    sourceSnapshot: snapshotSource,
  }, null, 2) + "\n");
  console.log(`Archived APK: ${directory}`);
  return directory;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [apk, note = "Local Android test build", ...flags] = process.argv.slice(2);
  if (!apk) throw new Error('Usage: node mobile/scripts/archive-apk.mjs <apk> "build notes" [--snapshot-source]');
  archiveApk(resolve(apk), note, { snapshotSource: flags.includes("--snapshot-source") });
}
