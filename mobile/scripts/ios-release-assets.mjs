// Validate and publish only this iOS build's files, preserving other platform assets and release notes.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
  const sourceCommit = process.env.GITHUB_SHA || run("git", ["rev-parse", "HEAD"]).trim();
  const repo = process.env.GITHUB_REPOSITORY || "jrucho/YT-Beatmaker-Cues-Desktop";
  writeFileSync(join(release, metadata), JSON.stringify({
    version, sourceCommit, signing: "unsigned", builtAt: new Date().toISOString(),
    xcode: run("xcodebuild", ["-version"]).trim(),
    runURL: process.env.GITHUB_RUN_ID ? `https://github.com/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}` : null,
    files: Object.fromEntries([ipa, xcode].map(name => [name, { sha256: hash(name) }])),
  }, null, 2) + "\n");
  writeFileSync(join(release, checksum), files.map(name => `${hash(name)}  ${name}\n`).join(""));
  console.log(`Verified unsigned arm64 iOS ${version} build and recorded ${sourceCommit}`);
} else if (mode === "publish") {
  const tag = process.argv[3];
  assert.equal(tag, `v${version}`, "Release tag must match the built mobile version");
  const repo = process.env.GITHUB_REPOSITORY || "jrucho/YT-Beatmaker-Cues-Desktop";
  const gh = args => run("gh", [...args, "--repo", repo]);
  const build = JSON.parse(readFileSync(join(release, metadata), "utf8"));
  assert.equal(build.version, version);
  assert.equal(build.signing, "unsigned");
  for (const name of [ipa, xcode]) assert.equal(hash(name), build.files[name].sha256, `${name} checksum differs`);
  const old = JSON.parse(gh(["release", "view", tag, "--json", "body,url"]));
  const start = "<!-- ios-release:start -->", end = "<!-- ios-release:end -->";
  const section = `${start}\n### iOS IPA and Xcode project\n\n` +
    `- **${ipa}**: unsigned arm64 iOS installer, built automatically on GitHub with Xcode 26+. Sign it with your Apple account using a sideloading tool, or build/install through Xcode.\n` +
    `- **${xcode}**: portable Xcode project with the built interface and native/plugin sources. Open App.xcodeproj, select the App scheme and your development team.\n` +
    `- Fixed songs stuck loading: validated 1 MB byte-range downloads with bounded retries now serve selected songs and next-track preparation. Only complete files enter the cache.\n` +
    `- If app.musike.ios is unavailable to your team, select your own unique bundle identifier. No personal signing credentials are included.\n` +
    `- Native playlist advancement and next-track preparation continue with the screen off; returning to the app reconciles its current song and playhead.\n` +
    `- Android/iOS parity includes sequential cue marking, IN/OUT loops, 1% faders, independent semitone tuning and MIDI inputs.\n` +
    `- Checksums: **${checksum}**. Build/source details: **${metadata}**.\n` +
    `- Source commit: [${build.sourceCommit.slice(0, 8)}](https://github.com/${repo}/commit/${build.sourceCommit})` +
    (build.runURL ? ` · [GitHub build](${build.runURL})` : "") + `.\n\n` +
    `Native archive, automated control/queue checks and six downloader regression checks passed. The playback fix was verified on an iPhone 17 Pro; the reproduced song reached playback in about 1.7 seconds. Audible cue timing and physical-device screen-off/MIDI behavior still need further testing. Cue smoothing is not part of this update. Version 1.0.2 remains the recommended stable baseline; the next update is 1.0.3.\n${end}`;
  const notes = old.body.includes(start)
    ? old.body.replace(/<!-- ios-release:start -->[\s\S]*?<!-- ios-release:end -->/, section)
    : old.body.replace(`## ${version}\n`, `## ${version}\n\n${section}\n`);
  assert(notes.includes(section), "Could not locate the version heading in release notes");
  gh(["release", "upload", tag, ...[...files, checksum].map(name => join(release, name)), "--clobber"]);
  run("gh", ["release", "edit", tag, "--repo", repo, "--notes-file", "-"], { input: notes });
  const published = JSON.parse(gh(["release", "view", tag, "--json", "assets"]));
  for (const name of [...files, checksum]) {
    const asset = published.assets.find(asset => asset.name === name);
    assert(asset && asset.state === "uploaded", `Missing uploaded asset: ${name}`);
    assert.equal(asset.digest, `sha256:${hash(name)}`, `GitHub digest differs: ${name}`);
  }
  console.log(`Updated and verified ${old.url}`);
} else {
  throw new Error("Usage: node mobile/scripts/ios-release-assets.mjs prepare | publish <existing-tag>");
}
