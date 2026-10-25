// Validate iOS assets. Coordinated draft creation is handled by candidate.yml.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {sourceInfo} from '../../scripts/source-info.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const { version } = JSON.parse(readFileSync(join(root, "mobile/package.json"), "utf8"));
const release = join(root, "release");
const ipa = `Beatmaker-Cues-Test-${version}-iOS.ipa`;
const xcode = `Beatmaker-Cues-Xcode-${version}.zip`;
const metadata = `iOS-Build-${version}.json`;
const checksum = `SHA256SUMS-iOS-${version}.txt`;
const files = [ipa, xcode, metadata];
const hash = name => createHash("sha256").update(readFileSync(join(release, name))).digest("hex");
const run = (command, args, options = {}) => execFileSync(command, args, { cwd: root, encoding: "utf8", ...options });
const mode = process.argv[2];

if (mode === "prepare") {
  for (const name of [ipa, xcode]) {
    assert(existsSync(join(release, name)), `Missing ${name}`);
    run("unzip", ["-tq", join(release, name)]);
  }
  const app = join(root, "mobile/ios/build/Musike.xcarchive/Products/Applications/App.app");
  const info = JSON.parse(run("plutil", ["-convert", "json", "-o", "-", join(app, "Info.plist")]));
  assert.equal(info.CFBundleShortVersionString, version);
  assert.equal(info.CFBundleIdentifier, "app.musike.ios");
  assert(run("lipo", ["-archs", join(app, info.CFBundleExecutable)]).includes("arm64"));
  const provenance=sourceInfo(root);
  const sourceCommit = provenance.sourceCommit;
  const repo = process.env.GITHUB_REPOSITORY || "jrucho/YT-Beatmaker-Cues-Desktop";
  writeFileSync(join(release, metadata), JSON.stringify({
    version, ...provenance, signing: "unsigned", builtAt: new Date().toISOString(),
    xcode: run("xcodebuild", ["-version"]).trim(),
    runURL: process.env.GITHUB_RUN_ID ? `https://github.com/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}` : null,
    files: Object.fromEntries([ipa, xcode].map(name => [name, { sha256: hash(name) }])),
  }, null, 2) + "\n");
  writeFileSync(join(release, checksum), files.map(name => `${hash(name)}  ${name}\n`).join(""));
  console.log(`Verified unsigned arm64 iOS ${version} build and recorded ${sourceCommit}`);
} else {
  throw new Error("Usage: node mobile/scripts/ios-release-assets.mjs prepare. Use the Complete release candidate workflow for coordinated draft creation.");
}
