import Capacitor
import Foundation

@objc(MusikeLibraryPlugin)
public final class MusikeLibraryPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "MusikeLibraryPlugin"
    public let jsName = "MusikeLibrary"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "info", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "read", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "commit", returnType: CAPPluginReturnPromise)
    ]
    private let worker = DispatchQueue(label: "app.beatmakercues.shared-library")
    private var store: SharedLibraryStore? {
        SharedLibraryStore.configured()
    }
    @objc public func info(_ call: CAPPluginCall) { call.resolve(["enabled": store != nil]) }
    @objc public func read(_ call: CAPPluginCall) {
        let legacy = call.getString("legacy")
        worker.async { do { guard let store = self.store else { call.reject("App Group sharing is unavailable"); return }; call.resolve(try store.read(legacy: legacy)) } catch { call.reject(error.localizedDescription) } }
    }
    @objc public func commit(_ call: CAPPluginCall) {
        guard let base = call.getString("base"), let edited = call.getString("edited") else { call.reject("Invalid library commit"); return }
        worker.async { do { guard let store = self.store else { call.reject("App Group sharing is unavailable"); return }; call.resolve(["json": try store.commit(base: base, edited: edited)]) } catch { call.reject(error.localizedDescription) } }
    }
}
