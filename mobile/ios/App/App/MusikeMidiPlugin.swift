import Capacitor
import CoreMIDI
import Foundation

/// USB/Bluetooth CoreMIDI sources expose the same events and pad mapping as MusikeMidi on Android.
@objc(MusikeMidiPlugin)
public final class MusikeMidiPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "MusikeMidiPlugin"
    public let jsName = "MusikeMidi"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "list", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "refresh", returnType: CAPPluginReturnPromise),
    ]
    private var client = MIDIClientRef()
    private var port = MIDIPortRef()
    private var sources: [MIDIEndpointRef] = []
    private var parsers: [Int: MidiByteParser] = [:]
    private let parserLock = NSLock()

    public override func load() {
        guard MIDIClientCreateWithBlock("Beatmaker Cues" as CFString, &client, { [weak self] _ in
            DispatchQueue.main.async { self?.connectSources() }
        }) == noErr else { return }
        let status = MIDIInputPortCreateWithBlock(client, "Cue pads" as CFString, &port) { [weak self] packets, connection in
            let source = connection.map { Int(bitPattern: $0) } ?? 0
            self?.receive(packets, source: source)
        }
        if status == noErr { connectSources() }
    }

    @objc public func list(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.connectSources()
            call.resolve(["devices": self.devices()])
        }
    }

    @objc public func refresh(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.connectSources()
            call.resolve()
        }
    }

    private func connectSources() {
        guard port != 0 else { return }
        let available = (0..<MIDIGetNumberOfSources()).map { MIDIGetSource($0) }.filter { $0 != 0 }
        for source in sources where !available.contains(source) {
            MIDIPortDisconnectSource(port, source)
            parserLock.lock()
            parsers.removeValue(forKey: Int(source))
            parserLock.unlock()
        }
        for source in available where !sources.contains(source) {
            MIDIPortConnectSource(port, source, UnsafeMutableRawPointer(bitPattern: Int(source)))
        }
        sources = available
        notifyListeners("devices", data: ["devices": devices()])
    }

    private func devices() -> [[String: Any]] {
        sources.map { source in
            var name: Unmanaged<CFString>?
            MIDIObjectGetStringProperty(source, kMIDIPropertyDisplayName, &name)
            return ["id": Int(source), "name": name?.takeRetainedValue() as String? ?? "MIDI input"]
        }
    }

    private func receive(_ list: UnsafePointer<MIDIPacketList>, source: Int) {
        let packetOffset = MemoryLayout<MIDIPacketList>.offset(of: \MIDIPacketList.packet)!
        let dataOffset = MemoryLayout<MIDIPacket>.offset(of: \MIDIPacket.data)!
        var packet = UnsafeRawPointer(list).advanced(by: packetOffset).assumingMemoryBound(to: MIDIPacket.self)
        var events: [[String: Any]] = []
        parserLock.lock()
        var parser = parsers[source] ?? MidiByteParser()
        for _ in 0..<list.pointee.numPackets {
            let bytes = UnsafeRawPointer(packet).advanced(by: dataOffset).assumingMemoryBound(to: UInt8.self)
            for byte in UnsafeBufferPointer(start: bytes, count: Int(packet.pointee.length)) {
                if let event = parser.feed(byte) { events.append(event) }
            }
            packet = UnsafePointer(MIDIPacketNext(packet))
        }
        parsers[source] = parser
        parserLock.unlock()
        if !events.isEmpty {
            DispatchQueue.main.async { [weak self] in
                for event in events { self?.notifyListeners("message", data: event) }
            }
        }
    }

    deinit {
        if port != 0 { MIDIPortDispose(port) }
        if client != 0 { MIDIClientDispose(client) }
    }
}

/// Handles running status and messages split across packets; MIDI clock bytes don't interrupt a note.
struct MidiByteParser {
    private var status: UInt8 = 0
    private var data: [UInt8] = []

    mutating func feed(_ byte: UInt8) -> [String: Any]? {
        if byte >= 0xF8 { return nil }
        if byte & 0x80 != 0 {
            status = byte < 0xF0 ? byte : 0
            data.removeAll(keepingCapacity: true)
            return nil
        }
        guard status != 0 else { return nil }
        data.append(byte)
        let kind = status & 0xF0
        let length = (kind == 0xC0 || kind == 0xD0) ? 1 : 2
        guard data.count == length else { return nil }
        defer { data.removeAll(keepingCapacity: true) }
        let channel = Int(status & 0x0F)
        switch kind {
        case 0x80, 0x90:
            return ["type": kind == 0x90 && data[1] > 0 ? "noteon" : "noteoff", "channel": channel,
                    "note": Int(data[0]), "velocity": Int(data[1])]
        case 0xB0:
            return ["type": "cc", "channel": channel, "controller": Int(data[0]), "value": Int(data[1])]
        default: return nil
        }
    }
}
