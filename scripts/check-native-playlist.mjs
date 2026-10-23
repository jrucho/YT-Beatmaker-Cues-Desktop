// Run the actual Android and iOS queue policies with no WebView, timers or UI callbacks involved.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
mkdirSync(join(root, "mobile/ios/build"), { recursive: true });
const work = mkdtempSync(join(root, "mobile/ios/build/playlist-test-"));
const run = (command, args, input) => {
  const result = spawnSync(command, args, { cwd: root, input, encoding: "utf8" });
  assert.equal(result.status, 0, `${command} failed:\n${result.stdout}\n${result.stderr}`);
  process.stdout.write(result.stdout);
};
try {
  run("python3", ["mobile/ios/Tests/test_audio_download.py"]);
  const harness = join(work, "PlaylistCheck.java");
  writeFileSync(harness, `package app.musike.android;
import java.util.*;
public class PlaylistCheck {
  static void check(boolean value) { if (!value) throw new AssertionError(); }
  public static void main(String[] args) {
    PlaylistCursor q = new PlaylistCursor();
    List<String> ids = Arrays.asList("a", "b", "c");
    q.replace(ids, 0, "off", true);
    List<String> played = new ArrayList<>(); played.add(q.current());
    while (q.next(true) >= 0) { q.index = q.next(true); played.add(q.current()); }
    check(played.equals(ids)); check(q.next(true) == -1);
    q.replace(ids, 2, "all", true); check(q.next(true) == 0);
    q.replace(ids, 1, "one", true); check(q.next(true) == 1); check(q.next(false) == 2);
    q.replace(Arrays.asList("c", "a", "b"), 0, "off", false); check(q.index == 2); check(q.current().equals("b"));
    q.replace(Collections.singletonList("b"), 0, "all", true); check(q.next(true) == 0);
    q.replace(Collections.emptyList(), 0, "off", true); check(q.next(true) == -1);
    System.out.println("PASS: Android native playlist advancement, end, repeat, queue edits and empty/single queues.");
  }
}`);
  const javaBin = process.env.JAVA_HOME ? join(process.env.JAVA_HOME, "bin") : null;
  run(javaBin ? join(javaBin, "javac") : "javac", ["-d", work, join(root, "mobile/android/app/src/main/java/app/musike/android/PlaylistCursor.java"), harness]);
  run(javaBin ? join(javaBin, "java") : "java", ["-cp", work, "app.musike.android.PlaylistCheck"]);
  const swift = readFileSync(join(root, "mobile/ios/App/App/PlaylistCursor.swift"), "utf8");
  run("xcrun", ["swift", "-module-cache-path", "mobile/ios/build/MacModuleCache", "-"], swift + `
var q = PlaylistCursor()
let ids = ["a", "b", "c"]
q.replace(ids, requested: 0, mode: "off", bind: true)
var played = [q.current]
while let next = q.next(automatic: true) { q.index = next; played.append(q.current) }
assert(played == ids && q.next(automatic: true) == nil)
q.replace(ids, requested: 2, mode: "all", bind: true); assert(q.next(automatic: true) == 0)
q.replace(ids, requested: 1, mode: "one", bind: true); assert(q.next(automatic: true) == 1 && q.next(automatic: false) == 2)
q.replace(["c", "a", "b"], requested: 0, mode: "off", bind: false); assert(q.index == 2 && q.current == "b")
q.replace(["b"], requested: 0, mode: "all", bind: true); assert(q.next(automatic: true) == 0)
q.replace([], requested: 0, mode: "off", bind: true); assert(q.next(automatic: true) == nil)
print("PASS: iOS native playlist advancement, end, repeat, queue edits and empty/single queues.")
`);
} finally { rmSync(work, { recursive: true, force: true }); }
