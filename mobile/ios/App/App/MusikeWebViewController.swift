import Capacitor
import UIKit
import WebKit

/// The app's web view: Capacitor's own, plus the two bridges iOS needs that Android has in its Java code —
/// the lock screen (MusikePlayback) and resolving a stream URL (MusikeYouTube).
final class MusikeWebViewController: CAPBridgeViewController {
    private let playback = MusikePlayback()
    private let youtube = MusikeYouTube()
    private let audio = MusikeAudio()

    override func capacitorDidLoad() {
        super.capacitorDidLoad()
        // Capacitor replaces the web view's userContentController after the configuration is built, so the handlers
        // are added here, once the web view exists.
        webView?.configuration.userContentController.add(playback, name: "musikeMedia")
        webView?.configuration.userContentController.add(youtube, name: "musikeResolve")
        webView?.configuration.userContentController.addScriptMessageHandler(audio, contentWorld: .page, name: "musikeAudio")
        bridge?.registerPluginInstance(MusikeMidiPlugin())
        playback.attach(webView)
        youtube.attach(webView)
        audio.attach(webView)
        playback.nativeAction = { [weak audio] action, position in audio?.handleRemote(action, position: position) ?? false }
        audio.onState = { [weak playback] playing, position, duration, rate in
            playback?.updateAudio(playing: playing, position: position, duration: duration, rate: rate)
        }
        audio.onTrack = { [weak playback] track in playback?.updateTrack(track) }
        // Swipe from the left edge goes back, like the Android back button: dialogs close, then pages.
        webView?.allowsBackForwardNavigationGestures = true
    }
}
