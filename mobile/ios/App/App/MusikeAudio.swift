import AVFoundation
import CryptoKit
import UIKit
@preconcurrency import WebKit

/// The iOS implementation of the Android audio contract. Cached files feed a native player node;
/// independent time/pitch processing never goes through WKWebView or a remote-media seek.
final class MusikeAudio: NSObject, WKScriptMessageHandlerWithReply {
    private weak var webView: WKWebView?
    private static var knownDurations: [String: Double] = [:]
    private let engine = AVAudioEngine()
    private let node = AVAudioPlayerNode()
    private let cueTail = AVAudioPlayerNode()
    private let cueMixer = AVAudioMixerNode()
    private let varispeed = AVAudioUnitVarispeed()
    private let timePitch = AVAudioUnitTimePitch()
    private var file: AVAudioFile?
    private var download: AudioFileDownload?
    private var ticker: Timer?
    private var observers: [NSObjectProtocol] = []
    private var sourceID = 0
    private var loadGeneration = 0
    private var scheduleID = 0
    private var wantedPlaying = false
    private var resumeAfterInterruption = false
    private var pendingPosition = 0.0
    private var anchor: AVAudioFramePosition = 0
    private var duration = 0.0
    private var rate = 1.0
    private var preservePitch = true
    private var semitones = 0.0
    private var volume: Float = 1
    private var muted = false
    private var loopFrom = 0.0
    private var loopTo = 0.0
    private var loopOn = false
    private var scheduledLoop = false
    private var endFrame: AVAudioFramePosition = 0
    private var loopStartFrame: AVAudioFramePosition = 0
    private var loopEndFrame: AVAudioFramePosition = 0
    var onState: ((Bool, Double, Double, Double) -> Void)?
    var onTrack: (([String: Any]) -> Void)?
    private var queue = PlaylistCursor()
    private var tracks: [[String: Any]] = []
    private let resolver = MusikeYouTube()
    private struct PreparedTrack { let remote: String; let local: URL; let duration: Double }
    private var prepared: [String: PreparedTrack] = [:]
    private var preparing: [String: [(Result<PreparedTrack, Error>) -> Void]] = [:]
    private var transition = 0
    private var advancing = false
    private var sourceURL = ""
    private var backgroundTask = UIBackgroundTaskIdentifier.invalid
    private var failedTracks = 0
    private var lastResumeSave = Date.distantPast
    private let resumeKey = "musike:audio:resume"

    private let cacheDirectory = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("BeatmakerCuesAudio", isDirectory: true)

    override init() {
        super.init()
        engine.attach(node)
        engine.attach(cueTail)
        engine.attach(cueMixer)
        engine.attach(varispeed)
        engine.attach(timePitch)
        try? FileManager.default.createDirectory(at: cacheDirectory, withIntermediateDirectories: true)
        let notifications = NotificationCenter.default
        observers.append(notifications.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] notification in
            guard let self, let raw = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
                  let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
            if type == .began {
                self.resumeAfterInterruption = self.wantedPlaying
                self.pause()
            } else {
                let options = AVAudioSession.InterruptionOptions(rawValue: notification.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0)
                if self.resumeAfterInterruption && options.contains(.shouldResume) { self.play() }
                self.resumeAfterInterruption = false
            }
        })
        observers.append(notifications.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main) { [weak self] _ in
            guard let self, self.file != nil else { return }
            // A configuration change may already have reset the node's render clock.
            let at = self.pendingPosition
            self.schedule(at: at, playing: self.wantedPlaying)
        })
        observers.append(notifications.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main) { [weak self] notification in
            let reason = notification.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt
            if reason == AVAudioSession.RouteChangeReason.oldDeviceUnavailable.rawValue { self?.pause() }
        })
    }

    func attach(_ webView: WKWebView?) { self.webView = webView }

    static func cachedTrack(_ id: String) -> [String: Any]? {
        guard id.range(of: "^[A-Za-z0-9_-]{11}$", options: .regularExpression) != nil else { return nil }
        if id.range(of: "^loc[0-9a-f]{8}$", options: .regularExpression) != nil {
            guard let store = SharedLibraryStore.configured(), let file = try? store.media(id), let audio = try? AVAudioFile(forReading: file), audio.length > 0 else { return nil }
            return ["url": file.absoluteString, "mime": "audio/wav", "title": id, "duration": Double(audio.length) / audio.processingFormat.sampleRate]
        }
        let file = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("BeatmakerCuesAudio/song-\(id).m4a")
        guard FileManager.default.fileExists(atPath: file.path), let audio = try? AVAudioFile(forReading: file), audio.length > 0 else { return nil }
        return ["url": file.absoluteString, "mime": "audio/mp4", "title": id,
                "duration": Double(audio.length) / audio.processingFormat.sampleRate]
    }

    static func remember(url: String, duration: Double) {
        guard duration.isFinite, duration > 0 else { return }
        let save = {
            if knownDurations.count > 80 { knownDurations.removeAll() }
            knownDurations[url] = duration
        }
        if Thread.isMainThread { save() }
        else { DispatchQueue.main.async(execute: save) }
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        guard let body = message.body as? [String: Any], let command = body["cmd"] as? String else {
            replyHandler(nil, "Invalid audio command")
            return
        }
        let id = (body["sourceId"] as? NSNumber)?.intValue ?? sourceID
        #if DEBUG
        if !["position", "snapshot"].contains(command) { NSLog("Musike audio command: %@ source=%d", command, id) }
        #endif
        if ["position", "seek", "cue", "loop"].contains(command), id != sourceID {
            replyHandler(nil, "Audio source changed")
            return
        }
        switch command {
        case "load":
            transition += 1
            advancing = false
            replaceQueue(body["queue"] as? [String: Any], bind: true)
            load(body["url"] as? String ?? "", id: id, startAt: number(body["startAt"]))
        case "queue": replaceQueue(body["queue"] as? [String: Any], bind: false)
        case "snapshot": replyHandler(snapshot(), nil); return
        case "play": play()
        case "pause": pause()
        case "seek": schedule(at: number(body["to"]), playing: wantedPlaying)
        case "cue":
            schedule(at: number(body["to"]), playing: true, smoothCue: true)
            if file != nil, let pad = body["pad"] as? Int, let bank = body["bank"] as? String {
                emit("pad", ["bank": bank, "pad": pad])
            }
        case "position":
            replyHandler(["position": position()], nil)
            return
        case "loop":
            let at = position()
            loopFrom = max(0, number(body["from"]))
            loopTo = number(body["to"])
            loopOn = body["on"] as? Bool == true && loopTo > loopFrom
            if file != nil { schedule(at: at, playing: wantedPlaying) }
        case "volume": volume = Float(min(1, max(0, number(body["value"], fallback: 1)))); applyVolume()
        case "muted": muted = body["value"] as? Bool ?? false; applyVolume()
        case "rate":
            rate = min(4, max(0.25, number(body["value"], fallback: 1)))
            preservePitch = body["preservePitch"] as? Bool ?? true
            semitones = min(12, max(-12, number(body["semitones"])))
            applyRate()
            publishState()
        default: break
        }
        replyHandler([:], nil)
    }

    // MARK: - Local compressed-file cache

    private func load(_ link: String, id: Int, startAt: Double, autoplay: Bool = false, remote: String? = nil, announce: Bool = false) {
        sourceID = id
        sourceURL = remote ?? link
        loadGeneration += 1
        let generation = loadGeneration
        scheduleID += 1
        wantedPlaying = autoplay
        pendingPosition = max(0, startAt)
        duration = 0
        loopOn = false
        scheduledLoop = false
        download?.cancel()
        download = nil
        node.stop()
        cueTail.stop()
        engine.stop()
        file = nil
        ticker?.invalidate()
        ticker = nil
        guard !link.isEmpty else { return }
        if announce {
            if let loop = currentTrack()["loop"] as? [String: Any] {
                loopFrom = number(loop["from"])
                loopTo = number(loop["to"])
                loopOn = loop["on"] as? Bool == true && loopTo > loopFrom
            }
            onTrack?(currentTrack())
            emit("track", snapshot())
        }
        guard let url = URL(string: link), ["https", "http", "file"].contains(url.scheme ?? "") else {
            emit("error", ["message": "Invalid audio URL"])
            return
        }
        let name = queue.current.range(of: "^[A-Za-z0-9_-]{11}$", options: .regularExpression) != nil
            ? "song-\(queue.current).m4a"
            : SHA256.hash(data: Data(link.utf8)).map { String(format: "%02x", $0) }.joined() + ".m4a"
        let cached = cacheDirectory.appendingPathComponent(name)
        if url.isFileURL { open(url, original: link); return }
        if FileManager.default.fileExists(atPath: cached.path) {
            try? FileManager.default.setAttributes([.modificationDate: Date()], ofItemAtPath: cached.path)
            open(cached, original: link)
            return
        }
        download = AudioFileDownload(source: url, destination: cached) { [weak self] result in
            DispatchQueue.main.async {
                guard let self, self.sourceID == id, self.loadGeneration == generation else { return }
                self.download = nil
                switch result {
                case .success(let local): self.open(local, original: link)
                case .failure(let error): self.emit("error", ["message": error.localizedDescription])
                }
            }
        }
        download?.resume()
    }

    private func open(_ url: URL, original: String) {
        do {
            let audio = try AVAudioFile(forReading: url)
            let measured = Double(audio.length) / audio.processingFormat.sampleRate
            guard measured.isFinite, measured > 0 else { throw NSError(domain: "BeatmakerCuesAudio", code: 2) }
            duration = min(Self.knownDurations[original] ?? measured, measured)
            endFrame = min(audio.length, AVAudioFramePosition(duration * audio.processingFormat.sampleRate))
            file = audio
            engine.disconnectNodeOutput(node)
            engine.disconnectNodeOutput(cueTail)
            engine.disconnectNodeOutput(cueMixer)
            engine.disconnectNodeOutput(varispeed)
            engine.disconnectNodeOutput(timePitch)
            engine.connect(node, to: cueMixer, fromBus: 0, toBus: 0, format: audio.processingFormat)
            engine.connect(cueTail, to: cueMixer, fromBus: 0, toBus: 1, format: audio.processingFormat)
            engine.connect(cueMixer, to: varispeed, format: audio.processingFormat)
            engine.connect(varispeed, to: timePitch, format: audio.processingFormat)
            engine.connect(timePitch, to: engine.mainMixerNode, format: audio.processingFormat)
            applyRate()
            applyVolume()
            schedule(at: pendingPosition, playing: wantedPlaying)
            emit("ready", ["duration": duration])
            emitTime()
            ticker = Timer(timeInterval: 0.25, repeats: true) { [weak self] _ in self?.emitTime() }
            if let ticker { RunLoop.main.add(ticker, forMode: .common) }
            trimCache(keeping: url)
            failedTracks = 0
            advancing = false
            endBackgroundTask()
            warmNext()
        } catch { emit("error", ["message": error.localizedDescription]) }
    }

    private func trimCache(keeping active: URL) {
        let keys: Set<URLResourceKey> = [.fileSizeKey, .contentModificationDateKey]
        guard let files = try? FileManager.default.contentsOfDirectory(at: cacheDirectory, includingPropertiesForKeys: Array(keys)) else { return }
        let entries = files.compactMap { url -> (URL, Int, Date)? in
            guard url.pathExtension == "m4a" else { return nil }
            guard let values = try? url.resourceValues(forKeys: keys) else { return nil }
            return (url, values.fileSize ?? 0, values.contentModificationDate ?? .distantPast)
        }.sorted { $0.2 < $1.2 }
        var bytes = entries.reduce(0) { $0 + $1.1 }
        for (url, size, _) in entries where bytes > 320 * 1024 * 1024 && url != active {
            if (try? FileManager.default.removeItem(at: url)) != nil { bytes -= size }
        }
    }

    // MARK: - Native cue, loop, varispeed and independent tuning

    private func activate() throws {
        if engine.isRunning { return }
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playback, mode: .default)
        try session.setPreferredIOBufferDuration(0.005)
        try session.setActive(true)
        if !engine.isRunning { engine.prepare(); try engine.start() }
    }

    private func schedule(at seconds: Double, playing: Bool, smoothCue: Bool = false) {
        let outgoingPosition = position()
        let wasPlaying = node.isPlaying
        pendingPosition = max(0, seconds.isFinite ? seconds : 0)
        wantedPlaying = playing
        guard let file else { return }
        scheduleID += 1
        let serial = scheduleID
        node.stop()
        cueTail.stop()
        let sampleRate = file.processingFormat.sampleRate
        anchor = min(max(0, AVAudioFramePosition(pendingPosition * sampleRate)), max(0, endFrame - 1))
        loopStartFrame = min(max(0, AVAudioFramePosition(loopFrom * sampleRate)), max(0, endFrame - 1))
        loopEndFrame = min(endFrame, AVAudioFramePosition(loopTo * sampleRate))
        scheduledLoop = loopOn && loopEndFrame > loopStartFrame
        if smoothCue && scheduledLoop && (anchor < loopStartFrame || anchor >= loopEndFrame) {
            loopOn = false
            scheduledLoop = false
        }
        if scheduledLoop {
            if anchor < loopStartFrame || anchor >= loopEndFrame { anchor = loopStartFrame }
            // Queue ahead. Refill when consumed, rather than waiting for a timer after OUT has passed.
            enqueueCueStart(start: anchor, end: loopEndFrame, serial: serial, looping: true, smooth: smoothCue)
            enqueue(start: loopStartFrame, end: loopEndFrame, serial: serial, looping: true)
        } else {
            enqueueCueStart(start: anchor, end: endFrame, serial: serial, looping: false, smooth: smoothCue)
        }
        if smoothCue && wasPlaying,
           let tail = cueBuffer(start: AVAudioFramePosition(outgoingPosition * sampleRate), end: endFrame, fadeIn: false) {
            cueTail.scheduleBuffer(tail)
        }
        pendingPosition = Double(anchor) / sampleRate
        emit("seeked", ["position": pendingPosition])
        if playing { play(); if smoothCue && wasPlaying && engine.isRunning { cueTail.play() } }
        else { publishState() }
    }

    /// A sample-domain 3 ms transition starts immediately, without waiting for a fade timer.
    /// Both voices share the speed/pitch chain so the transition follows the selected mode.
    private func cueBuffer(start: AVAudioFramePosition, end: AVAudioFramePosition, fadeIn: Bool) -> AVAudioPCMBuffer? {
        guard let file, start >= 0, end > start else { return nil }
        let count = AVAudioFrameCount(min(end - start, AVAudioFramePosition(file.processingFormat.sampleRate * 0.003)))
        guard count > 1, let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: count) else { return nil }
        do {
            file.framePosition = start
            try file.read(into: buffer, frameCount: count)
            guard let channels = buffer.floatChannelData, buffer.frameLength > 1 else { return nil }
            for channel in 0..<Int(buffer.format.channelCount) {
                for frame in 0..<Int(buffer.frameLength) {
                    let gain = Float(frame) / Float(buffer.frameLength - 1)
                    channels[channel][frame] *= fadeIn ? gain : 1 - gain
                }
            }
            return buffer
        } catch { return nil }
    }

    private func enqueueCueStart(start: AVAudioFramePosition, end: AVAudioFramePosition, serial: Int, looping: Bool, smooth: Bool) {
        // Leave at least one frame for the segment completion that owns queue advancement.
        if smooth, let buffer = cueBuffer(start: start, end: end - 1, fadeIn: true) {
            node.scheduleBuffer(buffer)
            enqueue(start: start + AVAudioFramePosition(buffer.frameLength), end: end, serial: serial, looping: looping)
        } else { enqueue(start: start, end: end, serial: serial, looping: looping) }
    }

    private func enqueue(start: AVAudioFramePosition, end: AVAudioFramePosition, serial: Int, looping: Bool) {
        guard let file, end > start else { return }
        let frames = AVAudioFrameCount(min(AVAudioFramePosition(UInt32.max), end - start))
        node.scheduleSegment(file, startingFrame: start, frameCount: frames, at: nil,
                             completionCallbackType: looping ? .dataConsumed : .dataPlayedBack) { [weak self] _ in
            DispatchQueue.main.async {
                guard let self, self.scheduleID == serial else { return }
                if looping {
                    self.enqueue(start: self.loopStartFrame, end: self.loopEndFrame, serial: serial, looping: true)
                } else {
                    if self.advance(automatic: true) { return }
                    self.wantedPlaying = false
                    self.pendingPosition = self.duration
                    self.node.stop()
                    self.anchor = self.endFrame
                    self.emitTime()
                    self.emit("ended")
                }
            }
        }
    }

    private func position() -> Double {
        guard let file else { return pendingPosition }
        guard node.isPlaying else { return min(duration, pendingPosition) }
        var frame = anchor
        if let render = node.lastRenderTime, let time = node.playerTime(forNodeTime: render) {
            frame += AVAudioFramePosition(Double(time.sampleTime) * file.processingFormat.sampleRate / time.sampleRate)
        }
        if scheduledLoop && frame >= loopEndFrame {
            frame = loopStartFrame + (frame - loopEndFrame) % max(1, loopEndFrame - loopStartFrame)
        }
        return min(duration, max(0, Double(frame) / file.processingFormat.sampleRate))
    }

    private func play() {
        wantedPlaying = true
        guard file != nil else { return }
        do {
            if anchor >= endFrame { schedule(at: 0, playing: false); wantedPlaying = true }
            try activate()
            node.play()
            emit("playing")
            publishState()
        } catch { wantedPlaying = false; emit("error", ["message": error.localizedDescription]) }
    }

    private func pause() {
        let at = position()
        node.pause()
        cueTail.stop()
        pendingPosition = at
        wantedPlaying = false
        emit("pause")
        publishState()
    }

    private func applyRate() {
        varispeed.rate = preservePitch ? 1 : Float(rate)
        timePitch.rate = preservePitch ? Float(rate) : 1
        timePitch.pitch = preservePitch ? Float(semitones * 100) : 0
        timePitch.bypass = !preservePitch || (rate == 1 && semitones == 0)
    }

    private func applyVolume() { cueMixer.outputVolume = muted ? 0 : volume }

    /// Handle core transport even while WKWebView is suspended in the background.
    func handleRemote(_ action: String, position: Double?) -> Bool {
        switch action {
        case "play": play()
        case "pause": pause()
        case "toggle": wantedPlaying ? pause() : play()
        case "seek": schedule(at: position ?? 0, playing: wantedPlaying)
        case "next": return advance(automatic: false)
        case "previous":
            if self.position() > 3 || queue.index == 0 { schedule(at: 0, playing: wantedPlaying) }
            else { startTrack(queue.index - 1) }
        default: return false
        }
        return true
    }

    private func publishState() { onState?(wantedPlaying && (node.isPlaying || advancing), position(), duration, rate) }

    // MARK: - Native playlist ownership (no JavaScript required between songs)

    private func replaceQueue(_ value: [String: Any]?, bind: Bool) {
        guard let value, let entries = value["tracks"] as? [[String: Any]] else { return }
        tracks = entries
        queue.replace(entries.map { $0["id"] as? String ?? "" }, requested: (value["index"] as? NSNumber)?.intValue ?? 0,
                      mode: value["repeat"] as? String ?? "off", bind: bind)
        if !bind { warmNext() }
    }

    private func currentTrack() -> [String: Any] { tracks.indices.contains(queue.index) ? tracks[queue.index] : [:] }

    private func snapshot() -> [String: Any] {
        if file == nil && sourceURL.isEmpty,
           let saved = UserDefaults.standard.dictionary(forKey: resumeKey),
           let id = saved["trackId"] as? String, let index = queue.ids.firstIndex(of: id) {
            return ["sourceId": sourceID, "queueIndex": index, "trackId": id,
                    "position": number(saved["position"]), "playing": false, "ready": false, "resume": true]
        }
        return ["sourceId": sourceID, "queueIndex": queue.index, "trackId": queue.current, "url": sourceURL,
         "position": advancing ? 0 : position(), "duration": duration, "buffered": file == nil ? 0 : duration,
         "playing": wantedPlaying, "ready": file != nil && !advancing,
         "loop": ["from": loopFrom, "to": loopTo, "on": loopOn]]
    }

    private func advance(automatic: Bool) -> Bool {
        guard let next = queue.next(automatic: automatic) else { return false }
        if next == queue.index { schedule(at: 0, playing: true); return true }
        startTrack(next)
        return true
    }

    private func startTrack(_ index: Int) {
        guard tracks.indices.contains(index) else { return }
        queue.index = index
        transition += 1
        let mine = transition
        advancing = true
        if backgroundTask == .invalid {
            backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "Next playlist track") { [weak self] in self?.endBackgroundTask() }
        }
        onTrack?(currentTrack())
        publishState()
        prepareTrack(index) { [weak self] result in
            guard let self, self.transition == mine else { return }
            switch result {
            case .success(let track):
                Self.remember(url: track.local.absoluteString, duration: track.duration)
                let playing = self.wantedPlaying
                self.load(track.local.absoluteString, id: self.sourceID, startAt: 0, autoplay: playing, remote: track.remote, announce: true)
            case .failure(let error):
                self.failedTracks += 1
                if self.failedTracks < self.tracks.count && self.advance(automatic: false) { return }
                self.advancing = false
                self.wantedPlaying = false
                self.endBackgroundTask()
                self.emit("error", ["message": error.localizedDescription])
                self.publishState()
            }
        }
    }

    private func warmNext() {
        guard let next = queue.next(automatic: false), next != queue.index else { return }
        prepareTrack(next) { _ in }
    }

    private func prepareTrack(_ index: Int, done: @escaping (Result<PreparedTrack, Error>) -> Void) {
        guard tracks.indices.contains(index), let id = tracks[index]["id"] as? String else { return }
        if let cached = prepared[id], FileManager.default.fileExists(atPath: cached.local.path) { done(.success(cached)); return }
        if preparing[id] != nil { preparing[id]?.append(done); return }
        preparing[id] = [done]
        resolver.resolve(videoId: id, lang: "en", region: "US") { [weak self] payload in
            DispatchQueue.main.async {
                guard let self else { return }
                guard let link = payload["url"] as? String, let url = URL(string: link) else {
                    self.finishPreparation(id, .failure(NSError(domain: "BeatmakerCuesAudio", code: 3,
                        userInfo: [NSLocalizedDescriptionKey: payload["error"] as? String ?? "Could not resolve the next song"])))
                    return
                }
                let duration = self.number(payload["duration"])
                let local = self.cacheDirectory.appendingPathComponent("song-\(id).m4a")
                if FileManager.default.fileExists(atPath: local.path) {
                    self.finishPreparation(id, .success(PreparedTrack(remote: link, local: local, duration: duration)))
                    return
                }
                AudioFileDownload(source: url, destination: local) { [weak self] downloaded in
                    let result = downloaded.map { PreparedTrack(remote: link, local: $0, duration: duration) }
                    DispatchQueue.main.async { self?.finishPreparation(id, result) }
                }.resume()
            }
        }
    }

    private func finishPreparation(_ id: String, _ result: Result<PreparedTrack, Error>) {
        if case .success(let track) = result { prepared[id] = track }
        let callbacks = preparing.removeValue(forKey: id) ?? []
        for callback in callbacks { callback(result) }
    }

    private func endBackgroundTask() {
        if backgroundTask != .invalid { UIApplication.shared.endBackgroundTask(backgroundTask); backgroundTask = .invalid }
    }

    private func emitTime() {
        let at = position()
        pendingPosition = at
        if file != nil && !queue.current.isEmpty && Date().timeIntervalSince(lastResumeSave) >= 1 {
            UserDefaults.standard.set(["trackId": queue.current, "position": at], forKey: resumeKey)
            lastResumeSave = Date()
        }
        emit("time", ["position": at, "duration": duration, "buffered": file == nil ? 0 : duration])
        publishState()
    }

    private func number(_ value: Any?, fallback: Double = 0) -> Double {
        guard let number = value as? NSNumber, number.doubleValue.isFinite else { return fallback }
        return number.doubleValue
    }

    private func emit(_ event: String, _ payload: [String: Any] = [:]) {
        #if DEBUG
        if event != "time" { NSLog("Musike audio event: %@ %@", event, String(describing: payload)) }
        #endif
        var data = payload
        data["sourceId"] = sourceID
        guard let encoded = try? JSONSerialization.data(withJSONObject: data), let json = String(data: encoded, encoding: .utf8) else { return }
        webView?.evaluateJavaScript("window.__musikeAudioEvent && window.__musikeAudioEvent('\(event)', \(json))")
    }

    deinit {
        download?.cancel()
        ticker?.invalidate()
        for observer in observers { NotificationCenter.default.removeObserver(observer) }
        node.stop()
        engine.stop()
    }
}
