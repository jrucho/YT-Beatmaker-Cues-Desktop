import Foundation

@main struct SharedLibraryTests {
    static func json(_ value: Any) throws -> String { String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), as: UTF8.self) }
    static func check(_ condition: Bool, _ message: String) throws { if !condition { throw NSError(domain: "SharedLibraryTests", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) } }
    static func main() throws {
        let args = CommandLine.arguments
        if args.count == 5, args[1] == "--writer" {
            let store = SharedLibraryStore(directory: URL(fileURLWithPath: args[2], isDirectory: true))
            for i in 0..<(Int(args[4]) ?? 0) {
                var read = try store.read()
                if read["needsMigration"] as? Bool == true { read = try store.read(legacy: "{\"favorites\":[],\"playlists\":[],\"history\":[]}") }
                let base = read["json"] as! String
                var edited = try JSONSerialization.jsonObject(with: Data(base.utf8)) as! [String: Any]
                var playlists = edited["playlists"] as! [[String: Any]]
                playlists.append(["id": args[3] + String(i), "name": "Swift playlist", "tracks": [], "createdAt": 1, "updatedAt": 1])
                edited["playlists"] = playlists; _ = try store.commit(base: base, edited: json(edited))
            }
            return
        }
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("beatmaker-swift-store-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: folder) }
        let store = SharedLibraryStore(directory: folder)
        try check(try store.read()["needsMigration"] as? Bool == true, "Missing migration was not reported")
        let original = "{\"favorites\":[],\"history\":[],\"playlists\":[{\"id\":\"playlist1\",\"name\":\"日本語 🎵\",\"tracks\":[]}]}"
        let base = try store.read(legacy: original)["json"] as! String
        var rename = try JSONSerialization.jsonObject(with: Data(base.utf8)) as! [String: Any]
        var list = rename["playlists"] as! [[String: Any]]; list[0]["name"] = "Renamed"; rename["playlists"] = list
        _ = try store.commit(base: base, edited: json(rename))
        var added = try JSONSerialization.jsonObject(with: Data(base.utf8)) as! [String: Any]
        list = added["playlists"] as! [[String: Any]]; list[0]["tracks"] = [["id": "track000001", "title": "Preserved"]]; added["playlists"] = list
        let merged = try JSONSerialization.jsonObject(with: Data(store.commit(base: base, edited: json(added)).utf8)) as! [String: Any]
        let playlist = (merged["playlists"] as! [[String: Any]])[0]
        try check(playlist["name"] as? String == "Renamed" && (playlist["tracks"] as? [Any])?.count == 1, "Swift three-way merge lost an edit")
        _ = try store.read(legacy: original)
        let reopened = try SharedLibraryStore(directory: folder).read()["json"] as! String
        try check(reopened.contains("Renamed"), "Cold reopen or migration overwrote edits")
        print("PASS: Swift shared-library migration, field/track merge, Unicode and cold reopen")
    }
}
