import Foundation
import Darwin

/// Wire-compatible with the desktop/native library-v1 document and byte-0 lock.
/// All callers run off the main/audio thread. The original private files stay put.
final class SharedLibraryStore {
    static func configured() -> SharedLibraryStore? {
        let group = Bundle.main.object(forInfoDictionaryKey: "BeatmakerAppGroup") as? String ?? ""
        guard group.hasPrefix("group."), let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group) else { return nil }
        return SharedLibraryStore(directory: container.appendingPathComponent("Beatmaker Cues/SharedLibrary", isDirectory: true))
    }
    private static let processLock = NSLock()
    let directory: URL
    init(directory: URL) { self.directory = directory }
    private let migration = "ios-main-library:" + (Bundle.main.bundleIdentifier ?? "main") + ":v1"
    private func empty() -> [String: Any] { ["favorites": [], "playlists": [], "history": []] }
    private func valid(_ value: Any?) -> Bool {
        guard let library = value as? [String: Any] else { return false }
        return ["favorites", "playlists", "history"].allSatisfy { library[$0] is [Any] }
    }
    private func encoded(_ value: Any) throws -> Data { try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .fragmentsAllowed]) }
    private func locked<T>(_ action: () throws -> T) throws -> T {
        Self.processLock.lock(); defer { Self.processLock.unlock() }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let fd = Darwin.open(directory.appendingPathComponent("library.lock").path, O_CREAT | O_RDWR, S_IRUSR | S_IWUSR)
        guard fd >= 0 else { throw problem("Cannot open shared library lock") }
        defer { Darwin.close(fd) }
        var request = flock(l_start: 0, l_len: 1, l_pid: 0, l_type: Int16(F_WRLCK), l_whence: Int16(SEEK_SET))
        let deadline = Date().addingTimeInterval(5)
        while Darwin.fcntl(fd, F_SETLK, &request) != 0 {
            guard (errno == EAGAIN || errno == EACCES || errno == EINTR), Date() < deadline else { throw problem("Shared library is busy; retry the edit") }
            Thread.sleep(forTimeInterval: 0.005)
        }
        return try action()
    }
    private func problem(_ message: String) -> NSError { NSError(domain: "BeatmakerLibrary", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
    private func document() throws -> [String: Any] {
        var damaged = false
        for name in ["library-v1.json", "library-v1.backup.json"] {
            let url = directory.appendingPathComponent(name)
            guard FileManager.default.fileExists(atPath: url.path) else { continue }
            let data = try Data(contentsOf: url)
            if let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any], value["schema"] as? Int == 1, valid(value["library"]) { return value }
            damaged = true
        }
        if damaged { throw problem("Shared library needs recovery; original files have been retained") }
        return ["schema": 1, "revision": 0, "library": empty(), "preferences": [:]]
    }
    private func atomic(_ data: Data, to url: URL) throws {
        let temporary = directory.appendingPathComponent(UUID().uuidString + ".tmp")
        defer { try? FileManager.default.removeItem(at: temporary) }
        guard FileManager.default.createFile(atPath: temporary.path, contents: nil) else { throw problem("Cannot create library temporary file") }
        let output = try FileHandle(forWritingTo: temporary)
        do { try output.write(contentsOf: data); try output.synchronize(); try output.close() } catch { try? output.close(); throw error }
        guard Darwin.rename(temporary.path, url.path) == 0 else { throw problem("Cannot replace the shared library") }
    }
    private func save(_ value: [String: Any]) throws {
        let file = directory.appendingPathComponent("library-v1.json")
        if FileManager.default.fileExists(atPath: file.path) {
            let old = try Data(contentsOf: file)
            if let previous = try? JSONSerialization.jsonObject(with: old) as? [String: Any], previous["schema"] as? Int == 1, valid(previous["library"]) {
                try atomic(old, to: directory.appendingPathComponent("library-v1.backup.json"))
            } else { try old.write(to: directory.appendingPathComponent("library-corrupt-" + UUID().uuidString + ".json")) }
        }
        try atomic(try encoded(value), to: file)
    }
    private func id(_ value: Any) -> String { (value as? [String: Any])?["id"] as? String ?? "" }
    private func merge(_ base: Any, _ edited: Any, _ latest: Any) throws -> Any {
        if try encoded(base) == encoded(edited) { return latest }
        if let before = base as? [Any], let changed = edited as? [Any], let current = latest as? [Any] {
            var old: [String: Any] = [:], now: [String: Any] = [:]
            for item in before where !id(item).isEmpty { if old[id(item)] == nil { old[id(item)] = item } }
            for item in current where !id(item).isEmpty { if now[id(item)] == nil { now[id(item)] = item } }
            var result: [Any] = []
            for item in changed {
                let key = id(item)
                if let original = old[key] {
                    if now[key] == nil, try encoded(original) == encoded(item) { continue }
                    result.append(try merge(original, item, now[key] ?? original))
                } else { result.append(item) }
            }
            let editedIds = Set(changed.map(id))
            result += current.filter { !id($0).isEmpty && old[id($0)] == nil && !editedIds.contains(id($0)) }
            return result
        }
        if let before = base as? [String: Any], let changed = edited as? [String: Any], var current = latest as? [String: Any] {
            for key in before.keys where changed[key] == nil { current.removeValue(forKey: key) }
            for (key, value) in changed { current[key] = try before[key].map { try merge($0, value, current[key] ?? NSNull()) } ?? value }
            return current
        }
        return edited
    }
    func read(legacy: String? = nil) throws -> [String: Any] {
        try locked {
            var value = try document(), imports = value["imports"] as? [String: Bool] ?? [:]
            if imports[migration] != true {
                guard let legacy = legacy else { return ["needsMigration": true] }
                let incoming = try JSONSerialization.jsonObject(with: Data(legacy.utf8))
                guard valid(incoming), var library = value["library"] as? [String: Any], let source = incoming as? [String: Any] else { throw problem("Invalid private library") }
                for key in ["favorites", "history", "playlists"] {
                    var items = library[key] as? [[String: Any]] ?? []
                    for item in source[key] as? [[String: Any]] ?? [] {
                        if let index = items.firstIndex(where: { id($0) == id(item) }) {
                            if key == "playlists" {
                                var tracks = items[index]["tracks"] as? [[String: Any]] ?? []
                                var ids = Set(tracks.map(id))
                                for track in item["tracks"] as? [[String: Any]] ?? [] where !ids.contains(id(track)) { tracks.append(track); ids.insert(id(track)) }
                                items[index]["tracks"] = tracks
                            }
                        } else { items.append(item) }
                    }
                    library[key] = key == "history" ? Array(items.prefix(60)) : items
                }
                imports[migration] = true; value["imports"] = imports; value["library"] = library
                value["revision"] = (value["revision"] as? Int ?? 0) + 1; try save(value)
            }
            return ["json": String(decoding: try encoded(value["library"] ?? empty()), as: UTF8.self)]
        }
    }
    func commit(base: String, edited: String) throws -> String {
        try locked {
            let before = try JSONSerialization.jsonObject(with: Data(base.utf8)), after = try JSONSerialization.jsonObject(with: Data(edited.utf8))
            guard valid(before), valid(after) else { throw problem("Invalid shared library edit") }
            var value = try document()
            var merged = try merge(before, after, value["library"] ?? empty()) as! [String: Any]
            merged["history"] = Array((merged["history"] as? [Any] ?? []).prefix(60)); value["library"] = merged
            value["revision"] = (value["revision"] as? Int ?? 0) + 1; try save(value)
            return String(decoding: try encoded(value["library"] ?? empty()), as: UTF8.self)
        }
    }
    func media(_ id: String) throws -> URL? {
        try locked {
            guard let entries = try document()["media"] as? [String: Any], let entry = entries[id] as? [String: Any], let path = entry["path"] as? String else { return nil }
            let file = URL(fileURLWithPath: path).standardizedFileURL
            guard file.path.hasPrefix(directory.appendingPathComponent("Media").standardizedFileURL.path + "/") else { return nil }
            return file
        }
    }
}
