import Foundation

@main
struct AudioFileDownloadTests {
    static func main() throws {
        let base = CommandLine.arguments[1]
        let directory = URL(fileURLWithPath: CommandLine.arguments[2])
        let expected = Data((0..<2_500_123).map { UInt8($0 % 251) })
        for name in ["ranges", "whole", "retry", "bad-range", "http-error", "cancel"] {
            let destination = directory.appendingPathComponent(name + ".m4a")
            var result: Result<URL, Error>?
            let download = AudioFileDownload(source: URL(string: base + "/" + name)!, destination: destination) {
                value in DispatchQueue.main.async { result = value }
            }
            if name == "cancel" { download.cancel() }
            download.resume()
            let deadline = Date().addingTimeInterval(15)
            while result == nil && Date() < deadline { RunLoop.current.run(until: Date().addingTimeInterval(0.01)) }
            guard let result else { fatalError("Timed out: \(name)") }
            switch result {
            case .success(let file):
                precondition(["ranges", "whole", "retry"].contains(name), "Unexpected success: \(name)")
                let actual = try Data(contentsOf: file)
                precondition(actual == expected, "Downloaded bytes differ: \(name)")
            case .failure:
                precondition(["bad-range", "http-error", "cancel"].contains(name), "Unexpected failure: \(name)")
                precondition(!FileManager.default.fileExists(atPath: destination.path))
            }
            let files = try FileManager.default.contentsOfDirectory(atPath: directory.path)
            precondition(!files.contains { $0.hasSuffix(".partial") }, "Partial file leaked")
            print("PASS: \(name)")
        }
    }
}
