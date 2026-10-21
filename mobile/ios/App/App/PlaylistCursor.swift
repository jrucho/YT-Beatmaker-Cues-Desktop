import Foundation

/// Queue policy stays native when WKWebView timers and JavaScript are suspended.
struct PlaylistCursor {
    private(set) var ids: [String] = []
    var index = 0
    var repeatMode = "off"
    var current: String { ids.indices.contains(index) ? ids[index] : "" }

    mutating func replace(_ next: [String], requested: Int, mode: String, bind: Bool) {
        let id = current
        let oldIndex = index
        ids = next
        repeatMode = mode
        if bind { index = max(0, min(requested, ids.count - 1)) }
        else if ids.indices.contains(oldIndex), ids[oldIndex] == id { index = oldIndex }
        else { index = ids.firstIndex(of: id) ?? 0 }
    }

    func next(automatic: Bool) -> Int? {
        guard !ids.isEmpty else { return nil }
        if automatic && repeatMode == "one" { return index }
        if index + 1 < ids.count { return index + 1 }
        return repeatMode == "all" ? 0 : nil
    }
}
