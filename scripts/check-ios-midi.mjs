// Exercise the actual Swift CoreMIDI byte parser without requiring an attached MIDI controller.
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const source = readFileSync(new URL("../mobile/ios/App/App/MusikeMidiPlugin.swift", import.meta.url), "utf8");
const parser = source.slice(source.indexOf("struct MidiByteParser"));
if (!parser.startsWith("struct MidiByteParser")) throw new Error("CoreMIDI parser not found");
const checks = `
var parser = MidiByteParser()
func feed(_ bytes: [UInt8]) -> [[String: Any]] { bytes.compactMap { parser.feed($0) } }
let notes = feed([0x90, 36, 127, 0xF8, 37, 100, 38, 0])
assert(notes.count == 3)
assert(notes[0]["type"] as? String == "noteon" && notes[0]["note"] as? Int == 36)
assert(notes[1]["note"] as? Int == 37 && notes[1]["velocity"] as? Int == 100)
assert(notes[2]["type"] as? String == "noteoff")
assert(feed([0xB2, 20]).isEmpty)
let cc = feed([0xFA, 127])
assert(cc.count == 1 && cc[0]["type"] as? String == "cc")
assert(cc[0]["channel"] as? Int == 2 && cc[0]["controller"] as? Int == 20 && cc[0]["value"] as? Int == 127)
assert(feed([0xF0, 0x01, 0x02, 0xF8, 0xF7, 42, 127]).isEmpty)
assert(feed([0xC0, 5, 0xD0, 80]).isEmpty)
let resumed = feed([0x91, 47, 64])
assert(resumed.count == 1 && resumed[0]["channel"] as? Int == 1 && resumed[0]["note"] as? Int == 47)
print("PASS: CoreMIDI running status, split packets, real-time bytes, velocity-zero note-off, CC mapping and SysEx filtering.")
`;
const result = spawnSync("xcrun", ["swift", "-module-cache-path", "mobile/ios/build/MacModuleCache", "-"], {
  cwd: root, input: `import Foundation\n${parser}\n${checks}`, encoding: "utf8",
});
process.stdout.write(result.stdout ?? "");
process.stderr.write(result.stderr ?? "");
if (result.status !== 0) process.exit(result.status ?? 1);
