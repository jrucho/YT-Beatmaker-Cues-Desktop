import Foundation

/// Fetch bounded ranges: some media servers stall an open-ended request indefinitely.
/// Only a complete, validated file is published to the audio cache.
final class AudioFileDownload {
    private static let session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 20
        configuration.timeoutIntervalForResource = 40
        return URLSession(configuration: configuration)
    }()
    private let queue = DispatchQueue(label: "app.musike.audio-download")
    private let source: URL
    private let destination: URL
    private let temporary: URL
    private let completion: (Result<URL, Error>) -> Void
    private var task: URLSessionDataTask?
    private var handle: FileHandle?
    private var offset: Int64 = 0
    private var total: Int64?
    private var attempts = 0
    private var finished = false
    private let chunkSize: Int64 = 1024 * 1024

    init(source: URL, destination: URL, completion: @escaping (Result<URL, Error>) -> Void) {
        self.source = source
        self.destination = destination
        self.temporary = destination.deletingLastPathComponent().appendingPathComponent(UUID().uuidString + ".partial")
        self.completion = completion
    }

    func resume() {
        queue.async {
            guard !self.finished, self.handle == nil else { return }
            do {
                guard FileManager.default.createFile(atPath: self.temporary.path, contents: nil) else {
                    throw self.failure("Could not create the audio download file")
                }
                self.handle = try FileHandle(forWritingTo: self.temporary)
                self.requestChunk()
            } catch { self.finish(.failure(error)) }
        }
    }

    func cancel() {
        queue.async {
            self.task?.cancel()
            self.finish(.failure(URLError(.cancelled)))
        }
    }

    private func requestChunk() {
        guard !finished else { return }
        let end = min(offset + chunkSize - 1, total.map { $0 - 1 } ?? Int64.max)
        var request = URLRequest(url: source)
        request.setValue("bytes=\(offset)-\(end)", forHTTPHeaderField: "Range")
        request.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
        request.setValue("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36", forHTTPHeaderField: "User-Agent")
        task = Self.session.dataTask(with: request) { data, response, error in
            self.queue.async {
                guard !self.finished else { return }
                if let error {
                    if self.attempts < 2 {
                        self.attempts += 1
                        self.requestChunk()
                    } else { self.finish(.failure(error)) }
                    return
                }
                do {
                    guard let response = response as? HTTPURLResponse, let data, !data.isEmpty else {
                        throw self.failure("The audio server returned an empty response")
                    }
                    if response.statusCode == 206 {
                        guard let header = response.value(forHTTPHeaderField: "Content-Range"),
                              header.hasPrefix("bytes ") else { throw self.failure("Missing audio byte range") }
                        let parts = header.dropFirst(6).split(whereSeparator: { $0 == "-" || $0 == "/" })
                        guard parts.count == 3, let start = Int64(parts[0]), let last = Int64(parts[1]),
                              let length = Int64(parts[2]), start == self.offset, last >= start,
                              last <= end, last < length, Int64(data.count) == last - start + 1,
                              self.total == nil || self.total == length else {
                            throw self.failure("The audio server returned an inconsistent byte range")
                        }
                        self.total = length
                    } else if response.statusCode == 200 && self.offset == 0 {
                        // Servers without range support may return the complete file in one response.
                        if response.expectedContentLength >= 0 && response.expectedContentLength != Int64(data.count) {
                            throw self.failure("The audio download was incomplete")
                        }
                        self.total = Int64(data.count)
                    } else {
                        throw self.failure("Could not download audio (HTTP \(response.statusCode))")
                    }
                    try self.handle?.write(contentsOf: data)
                    self.offset += Int64(data.count)
                    self.attempts = 0
                    if self.offset == self.total {
                        try self.handle?.close()
                        self.handle = nil
                        if FileManager.default.fileExists(atPath: self.destination.path) {
                            try FileManager.default.removeItem(at: self.temporary)
                        } else {
                            try FileManager.default.moveItem(at: self.temporary, to: self.destination)
                        }
                        self.finish(.success(self.destination))
                    } else { self.requestChunk() }
                } catch { self.finish(.failure(error)) }
            }
        }
        task?.resume()
    }

    private func failure(_ message: String) -> Error {
        NSError(domain: "BeatmakerCuesAudio", code: 5, userInfo: [NSLocalizedDescriptionKey: message])
    }

    private func finish(_ result: Result<URL, Error>) {
        guard !finished else { return }
        finished = true
        task = nil
        try? handle?.close()
        handle = nil
        try? FileManager.default.removeItem(at: temporary)
        completion(result)
    }
}
