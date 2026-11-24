"""Publish a verified 1.0.8 refresh without replacing the original tag or assets."""
import argparse
from hashlib import file_digest
import json
import os
from pathlib import Path
import re
import shutil
import subprocess


REPO = "jrucho/YT-Beatmaker-Cues-Desktop"
REF = "refs/heads/release/1.0.8-r2"
TAG = "v1.0.8"
ORIGINAL_COMMIT = "52580fb34df6d5e956d235e40766bc6c1ca32993"
ORIGINAL_SUMS_SHA256 = "28611c4eaca42733120d30aaaaa1135e237a1f30703d2b93c487520213191fb7"
SUMS = "SHA256SUMS-1.0.8.txt"
MANIFEST = "Release-Build-1.0.8.json"
MARKER = "<!-- beatmaker-cues-v1.0.8-r2 -->"


def sha256(file):
    with file.open("rb") as stream:
        return file_digest(stream, "sha256").hexdigest()


def checksums(file):
    rows = {}
    for line in file.read_text(encoding="utf-8").splitlines():
        match = re.fullmatch(r"([a-f0-9]{64})  ([A-Za-z0-9_.-]+)", line)
        if not match or match[2] in rows or match[2].count("1.0.8") != 1:
            raise RuntimeError("Invalid 1.0.8 checksum inventory")
        rows[match[2]] = match[1]
    if len(rows) != 32 or MANIFEST not in rows or SUMS in rows:
        raise RuntimeError("Unexpected 1.0.8 asset inventory")
    rows[SUMS] = sha256(file)
    return rows


def revised(name):
    return name.replace("1.0.8", "1.0.8-r2")


def stage_revision(staging, output, commit):
    verified = checksums(staging / SUMS)
    if set(verified) != {file.name for file in staging.iterdir()}:
        raise RuntimeError("Unexpected files in checked release staging")
    for name, expected in verified.items():
        if sha256(staging / name) != expected:
            raise RuntimeError(f"Invalid staged checksum: {name}")
    manifest = json.loads((staging / MANIFEST).read_text())
    if (manifest.get("version"), manifest.get("sourceCommit"), manifest.get("scope"), manifest.get("workingTreeDirty")) != (
        "1.0.8", commit, "native-and-desktop", False
    ):
        raise RuntimeError("This revision must use the exact checked CI source")
    output.mkdir()
    for name in sorted(verified.keys() - {SUMS, MANIFEST}):
        shutil.copyfile(staging / name, output / revised(name))
    manifest.update(revision=2, originalReleaseCommit=ORIGINAL_COMMIT,
                    assetNameMap={name: revised(name) for name in sorted(verified)},
                    assets={revised(name): value for name, value in verified.items() if name not in {SUMS, MANIFEST}})
    (output / revised(MANIFEST)).write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    hashes = {file.name: sha256(file) for file in sorted(output.iterdir())}
    checksum = output / revised(SUMS)
    checksum.write_text("".join(f"{digest}  {name}\n" for name, digest in hashes.items()), encoding="utf-8")
    return {**hashes, checksum.name: sha256(checksum)}


def gh(*args):
    return subprocess.check_output(["gh", *args, "--repo", REPO], text=True)


def api(endpoint):
    return json.loads(subprocess.check_output(["gh", "api", f"repos/{REPO}/{endpoint}"], text=True))


def guard_refs(commit):
    if api(f"git/ref/heads/{REF.removeprefix('refs/heads/')}")["object"]["sha"] != commit:
        raise RuntimeError("This build was superseded")
    tag = api(f"git/ref/tags/{TAG}")["object"]
    while tag["type"] == "tag":
        tag = api(f"git/tags/{tag['sha']}")["object"]
    if (tag["type"], tag["sha"]) != ("commit", ORIGINAL_COMMIT):
        raise RuntimeError("The original release tag no longer matches")


def release():
    value = json.loads(gh("release", "view", TAG, "--json", "tagName,isDraft,isPrerelease,assets,body,url"))
    if value["tagName"] != TAG or value["isDraft"] or value["isPrerelease"]:
        raise RuntimeError("Expected the existing stable 1.0.8 release")
    return value


def missing_assets(value, original, additions):
    actual = {asset["name"]: asset for asset in value["assets"]}
    if set(original) & set(additions) or not set(original) <= set(actual) <= set(original) | set(additions):
        raise RuntimeError("Unexpected original/revision asset inventory; no files were replaced")
    for name, entry in actual.items():
        expected = (original | additions)[name]
        if entry["size"] <= 0 or entry["digest"] != f"sha256:{expected}":
            raise RuntimeError(f"GitHub asset differs from its checksum: {name}")
    return sorted(additions.keys() - actual.keys())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("staging", type=Path)
    parser.add_argument("workspace", type=Path)
    args = parser.parse_args()
    commit = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
    if (os.environ.get("GITHUB_REPOSITORY"), os.environ.get("GITHUB_REF"), os.environ.get("GITHUB_SHA")) != (REPO, REF, commit):
        raise RuntimeError("Run only for the verified 1.0.8 revision branch")
    guard_refs(commit)
    args.workspace.mkdir()
    gh("release", "download", TAG, "--pattern", SUMS, "--dir", str(args.workspace))
    original = checksums(args.workspace / SUMS)
    if original[SUMS] != ORIGINAL_SUMS_SHA256:
        raise RuntimeError("Original 1.0.8 checksum list changed")
    output = args.workspace / "assets"
    additions = stage_revision(args.staging, output, commit)
    links = set(re.findall(r"/releases/download/v1\.0\.8/([A-Za-z0-9_.-]+)",
                          Path("docs/downloads-1.0.8-r2.md").read_text(encoding="utf-8")))
    if not links or not links <= set(additions):
        raise RuntimeError("The revision download guide does not match the staged files")
    value = release()
    missing = missing_assets(value, original, additions)
    print(f"Uploading {len(missing)} verified revision files; preserving {len(original)} originals", flush=True)
    if missing:
        gh("release", "upload", TAG, *(str(output / name) for name in missing))
    value = release()
    if missing_assets(value, original, additions):
        raise RuntimeError("Revision upload is incomplete")
    guard_refs(commit)
    block = (
        f"{MARKER}\n## Updated 1.0.8 downloads (r2)\n\n"
        "**Songs to sample** picks tracks from your library in a new horizontal row. "
        "YouTube playlists load more results without the continuation error, and Now Playing has clean artwork.\n\n"
        f"**[Download the updated native apps, plug-ins, or full studio](https://github.com/{REPO}/blob/{commit}/docs/downloads-1.0.8-r2.md)**"
        f" · [SHA-256 checksums](https://github.com/{REPO}/releases/download/{TAG}/{revised(SUMS)})\n\n"
        "The app version is still **1.0.8**. Choose files marked **1.0.8-r2** for this update. "
        "The original downloads below are unchanged.\n"
    )
    if MARKER not in value["body"]:
        notes = args.workspace / "release-notes.md"
        notes.write_text(f"{block}\n---\n\n{value['body']}", encoding="utf-8")
        gh("release", "edit", TAG, "--notes-file", str(notes))
    elif block not in value["body"]:
        raise RuntimeError("The revision already has a different release note")
    verified = release()
    if MARKER not in verified["body"] or missing_assets(verified, original, additions):
        raise RuntimeError("The verified release is incomplete")
    print(f"Published and verified {len(additions)} updated assets: {verified['url']}")


if __name__ == "__main__":
    main()
