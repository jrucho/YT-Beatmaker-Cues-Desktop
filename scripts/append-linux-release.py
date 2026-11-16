"""Stage a verified Linux addition without replacing existing platform builds.

This is deliberately separate from a fresh all-platform release assembly. The
previous binaries AND their exact corresponding-source downloads are retained.
Linux gets its own source archive/build record. No refs or releases are mutated.
"""
import argparse
import json
from pathlib import Path
import re
import runpy
import shutil
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parents[1]
REPOSITORY = "jrucho/YT-Beatmaker-Cues-Desktop"
helpers = runpy.run_path(str(ROOT / "scripts/prepare-stable-release.py"))
digest, safe_name = helpers["digest"], helpers["safe_name"]


def gh(*arguments):
    return json.loads(subprocess.check_output(["gh", *arguments], cwd=ROOT, text=True))


def checked_inventory(folder, manifest_name):
    entries = {}
    for line in (folder / manifest_name).read_text().splitlines():
        expected, name = line.split("  ", 1)
        if Path(name).name != name or name in entries or digest(folder / name) != expected:
            raise RuntimeError(f"Invalid checksum inventory: {name}")
        entries[name] = expected
    if {file.name for file in folder.iterdir()} != set(entries) | {manifest_name}:
        raise RuntimeError(f"Unexpected files outside checksum inventory: {folder}")
    return set(entries) | {manifest_name}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--previous", required=True, type=Path)
    parser.add_argument("--native", required=True, type=Path)
    parser.add_argument("--sources", required=True, type=Path)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    previous, native, sources, output = [getattr(args, name).resolve()
                                         for name in ("previous", "native", "sources", "output")]
    if output.exists() or any(output.is_relative_to(folder) for folder in (previous, native, sources)):
        raise RuntimeError("Use a new output directory outside the input directories")
    if subprocess.check_output(["git", "status", "--porcelain"], cwd=ROOT, text=True).strip():
        raise RuntimeError("Publication staging requires clean committed source")
    publication = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    version = json.loads((ROOT / "package.json").read_text())["version"]
    checksum_name, manifest_name = f"SHA256SUMS-{version}.txt", f"Release-Build-{version}.json"
    notes_name = f"Release-Notes-{version}.md"
    baseline = checked_inventory(previous, checksum_name)
    manifest = json.loads((previous / manifest_name).read_text())
    for entry in manifest["files"]:
        file = previous / entry["name"]
        if file.name not in baseline or digest(file) != entry["sha256"] or file.stat().st_size != entry["bytes"]:
            raise RuntimeError("Previous release manifest and assets differ")
    if {entry["name"] for entry in manifest["files"]} != baseline - {manifest_name, checksum_name}:
        raise RuntimeError("Previous release inventory is incomplete")
    release = gh("release", "view", f"v{version}", "--repo", REPOSITORY,
                 "--json", "tagName,isDraft,isPrerelease,assets")
    if release["isDraft"] or release["isPrerelease"] or release["tagName"] != f"v{version}":
        raise RuntimeError("Only append to the existing public stable release")
    if {asset["name"] for asset in release["assets"]} != baseline:
        raise RuntimeError("Published inventory changed; take a fresh baseline snapshot")
    for asset in release["assets"]:
        file = previous / asset["name"]
        if asset["digest"] != "sha256:" + digest(file) or asset["size"] != file.stat().st_size:
            raise RuntimeError(f"Baseline is not the exact published asset: {file.name}")
    reference = gh("api", f"repos/{REPOSITORY}/git/ref/tags/v{version}")["object"]
    while reference["type"] == "tag":
        reference = gh("api", f"repos/{REPOSITORY}/git/tags/{reference['sha']}")["object"]
    if reference["type"] != "commit" or reference["sha"] != manifest["initialSourceCommit"]:
        raise RuntimeError("Original release tag changed")

    run = gh("run", "view", args.run_id, "--repo", REPOSITORY,
             "--json", "headSha,status,conclusion,url,jobs")
    if run["status"] != "completed" or run["conclusion"] != "success":
        raise RuntimeError("The Linux run must have completed successfully")
    linux_commit = run["headSha"]
    jobs = [job for job in run["jobs"] if job["name"] == "desktop-plugins (ubuntu-24.04, main)"]
    if len(jobs) != 1 or jobs[0]["conclusion"] != "success":
        raise RuntimeError("Missing successful Linux main-edition job")
    required = {
        "Linux WebView runtime preflight", "Verify Electron/native shared-library interoperability",
        "Native engine/library tests in Linux display server", "Verify rename-safe native installer",
        "Compare native FX with the original browser graph", "Linux WebView child launcher check",
        "Real offline Linux WebView and native audio smoke test", "Linux standalone WebView startup",
        "Linux VST3 host check", "Package verified native targets",
        "Install Linux package in a clean runtime-only Ubuntu container", "Run actions/upload-artifact@v7",
    }
    steps = {step["name"]: step for step in jobs[0]["steps"]}
    if any(name not in steps or steps[name]["conclusion"] != "success" for name in required):
        raise RuntimeError("A required Linux build/runtime/packaging check did not pass")
    subprocess.run(["git", "merge-base", "--is-ancestor", linux_commit, publication], cwd=ROOT, check=True)
    changed = set(filter(None, subprocess.check_output(
        ["git", "diff", "--name-only", "-z", linux_commit, publication], cwd=ROOT).decode().split("\0")))
    allowed = {"README.md", "CHANGELOG.md", "plugin/README.md", ".github/workflows/stable.yml",
               "scripts/prepare-stable-release.py", "scripts/append-linux-release.py",
               f"docs/downloads-{version}.md", f"docs/release-{version}-notes.md",
               f"docs/native-feature-parity-{version}.md", f"docs/linux-native-validation-{version}.md"}
    if changed - allowed:
        raise RuntimeError(f"Build inputs changed after Linux CI: {sorted(changed - allowed)}")

    linux_checksum = f"SHA256SUMS-Plugins-{version}-Linux-x64.txt"
    linux_names = checked_inventory(native, linux_checksum)
    build_name = f"Plugin-Build-{version}-Linux-x64.json"
    expected_linux = {f"Beatmaker-Cues-Plug-ins-{version}-Linux-x64.zip",
                      f"Beatmaker-Cues-Plugin-Standalone-{version}-Linux-x64.zip",
                      f"Beatmaker-Cues-Plug-ins-{version}-Linux-x64.deb", build_name, linux_checksum}
    if linux_names != expected_linux or baseline & linux_names:
        raise RuntimeError("Unexpected Linux package inventory or collision with published assets")
    build = json.loads((native / build_name).read_text())
    for key, value in {"version": version, "sourceCommit": linux_commit, "workingTreeDirty": False,
                       "platform": "Linux", "architecture": "x64", "edition": "main",
                       "productName": "Beatmaker Cues", "runURL": run["url"]}.items():
        if build.get(key) != value:
            raise RuntimeError(f"Linux build provenance mismatch: {key}")
    if set(build["formats"]) != {"Standalone", "VST3"}:
        raise RuntimeError("Unexpected Linux native formats")
    if not {"engine", "persistence", "concurrency", "vst3-host", "webview-offline"} <= set(build["checks"]):
        raise RuntimeError("Missing Linux native checks")
    source_file = sources / f"Beatmaker-Cues-Plugin-Source-{version}.zip"
    source_record_file = sources / f"Source-Build-{version}.json"
    source_record = json.loads(source_record_file.read_text())
    if (source_record.get("sourceCommit") != linux_commit or source_record.get("workingTreeDirty") is not False
            or source_record.get("version") != version):
        raise RuntimeError("Linux corresponding source differs from the actual Linux build")
    for file in [source_file] + [native / name for name in linux_names if name.endswith(".zip")]:
        with zipfile.ZipFile(file) as archive:
            if archive.testzip() is not None or len(archive.namelist()) != len(set(archive.namelist())):
                raise RuntimeError(f"Corrupt/duplicate archive entries: {file.name}")
            for name in archive.namelist():
                safe_name(name)
                if set(Path(name).parts) & {".git", "node_modules", "Sessions", "LegacyImports"}:
                    raise RuntimeError(f"Private/generated archive content: {name}")
                if name.endswith("docs/ios-feature-development.md"):
                    raise RuntimeError("Private development notes must not be published")
            if file == source_file:
                identities = [name for name in archive.namelist() if name.count("/") == 1 and name.endswith("/SOURCE-INFO.json")]
                if len(identities) != 1:
                    raise RuntimeError("Missing Linux source identity")
                identity = json.loads(archive.read(identities[0]))
                if identity.get("version") != version or identity.get("sourceCommit") != linux_commit:
                    raise RuntimeError("Wrong source archive baseline")
                prefix = identities[0].rsplit("/", 1)[0] + "/"
                for relative in ("plugin/CMakeLists.txt", "plugin/Scripts/patch_juce_linux.py",
                                 "plugin/Tests/LinuxWebViewTransportTests.cpp", "scripts/check-linux-standalone.py"):
                    expected = subprocess.check_output(["git", "show", f"{linux_commit}:{relative}"], cwd=ROOT)
                    if archive.read(prefix + relative) != expected:
                        raise RuntimeError(f"Source file differs from verified build: {relative}")
                cmake = archive.read(prefix + "plugin/CMakeLists.txt").decode()
                for dependency in source_record["dependencies"]:
                    if not re.search(re.escape(dependency["repository"]) + "/archive/" + dependency["commit"], cmake):
                        raise RuntimeError("Source dependency pin mismatch")
            else:
                identities = [name for name in archive.namelist() if name.endswith("/BuildInfo.json")]
                if len(identities) != 1 or json.loads(archive.read(identities[0])) != build:
                    raise RuntimeError("Native ZIP's embedded build record differs")
    if (native / f"Beatmaker-Cues-Plug-ins-{version}-Linux-x64.deb").read_bytes()[:8] != b"!<arch>\n":
        raise RuntimeError("Linux installer is not a Debian package")
    linux_source_name = f"Beatmaker-Cues-Plugin-Source-{version}-Linux-x64.zip"
    linux_source_record_name = f"Source-Build-{version}-Linux-x64.json"
    additions = {name: native / name for name in linux_names}
    additions.update({linux_source_name: source_file, linux_source_record_name: source_record_file})
    if baseline & set(additions):
        raise RuntimeError("Additive source asset collides with an existing download")
    output.mkdir(parents=True)
    for name in baseline:
        shutil.copy2(previous / name, output / name)
    for name, file in additions.items():
        shutil.copy2(file, output / name)
    shutil.copy2(ROOT / f"docs/release-{version}-notes.md", output / notes_name)
    metadata = {notes_name, manifest_name, checksum_name}
    updated, retained = set(additions) | metadata, baseline - metadata
    old_commit = manifest["sourceCommit"]
    commits = {name: manifest.get("assetSourceCommits", {}).get(name, old_commit) for name in baseline}
    commits.update({name: linux_commit for name in additions})
    commits.update({name: publication for name in metadata})
    manifest["previousPublication"] = {key: manifest.get(key) for key in
                                      ("sourceCommit", "releaseCommit", "runURL", "refresh", "applicationBuildInputsUnchanged")}
    manifest.pop("applicationBuildInputsUnchanged", None)
    manifest.update(sourceCommit=publication, releaseCommit=publication, multipleBuildSources=True,
                    refresh="Add verified Linux x64 native packages; preserve all existing platform binaries and sources",
                    preservedBuildInputsUnchanged=True, linuxBuildInputsUnchangedAfterCI=True,
                    publicationMetadataFiles=sorted(changed), linuxNativeSourceCommit=linux_commit,
                    linuxCorrespondingSourceAsset=linux_source_name, linuxCorrespondingSourceRecord=linux_source_record_name,
                    linuxRunURL=run["url"], linuxCIRequiredSteps=sorted(required),
                    linuxManualHardwareAcceptance="Not recorded; automated headless validation only",
                    expandedPlatforms=["Linux-native"], updatedAssets=sorted(updated),
                    retainedAssets=sorted(retained), assetSourceCommits=commits)
    manifest["scope"] = list(dict.fromkeys(manifest["scope"] + ["Linux-native"]))
    manifest["excludedPlatforms"] = [item for item in manifest.get("excludedPlatforms", []) if item["platform"] != "Linux-native"]
    manifest["ciJobs"].append(dict(name="linux / " + jobs[0]["name"], conclusion="success",
                                   sourceCommit=linux_commit, runURL=run["url"]))
    manifest["buildRecords"].update({build_name: build, linux_source_record_name: source_record})
    all_names = baseline | set(additions)
    manifest["files"] = [dict(name=name, bytes=(output / name).stat().st_size,
                              sha256=digest(output / name), sourceCommit=commits[name])
                         for name in sorted(all_names - {manifest_name, checksum_name})]
    (output / manifest_name).write_text(json.dumps(manifest, indent=2) + "\n")
    (output / checksum_name).write_text("".join(
        f"{digest(output / name)}  {name}\n" for name in sorted(all_names - {checksum_name})))
    if any(digest(previous / name) != digest(output / name) for name in retained):
        raise RuntimeError("A retained platform asset changed")
    print(f"Verified {len(all_names)} staged assets: {len(additions)} Linux additions, "
          f"{len(retained)} byte-preserved assets, 3 metadata updates. No release/ref changed: {output}")


if __name__ == "__main__":
    main()
