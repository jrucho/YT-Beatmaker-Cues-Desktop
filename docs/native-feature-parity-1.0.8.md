# Native 1.0.8 parity checklist

Scope: macOS universal AU, VST3 and standalone; Windows x64 VST3 and
standalone; Linux x64 VST3 and standalone; Android arm64; and the iOS app
and AUv3. The separate full desktop studio is also packaged as 1.0.8 from
its pinned source, without porting the native feature changes.

| Behavior | Verification |
| --- | --- |
| **Add tracks** starts with saved playlists and can switch to **All tracks**. Audio files import directly into the chosen playlist. Cancel and undo do not remove retained audio or interrupt playback. | Native library UI regression; native persistent/concurrent storage tests. |
| The active playlist name uses the theme accent; `Playing` / `En lecture` is plain text beside the track count. No top banner or Library Health control. | Native library UI regression. |
| Library, Search, Now Playing and Cues open the playing playlist on the current song. Back returns to its card. Saved playlist and live-radio identity survive reopen, with no guessing based on overlap. Radio can be saved without including manually queued songs or changing playback. | Native library UI regression, including a 700-song resumed session. |
| Open and reopen the Cues playlist panel on the actual queue position without moving playback or tracking subsequent song changes. | Native WebView and UI regressions, compact and wide, past row 500 and with a duplicate song. |
| New songs select Pitch (varispeed); the rate fader is immediately usable. Previously used songs retain their saved mode and values. | Native engine tests, Cues UI regression and iOS WebView fixture. |
| A saved playlist's cover is editable, including saved YouTube imports and empty playlists. Mobile offers Photos and Files; desktop offers an image-file picker. Only the small JPEG is stored with the playlist. | Native library UI regression and iOS native picker fixture. |
| Now Playing meets the opaque tab bar in phone layouts. Source links are accent-coloured, not underlined. | Native library UI and iOS WebView regressions. |
| Mobile Home keeps two shortcut columns: three rows on standard phone layouts, four on taller ones. Recent covers and names remain visible above the player. Missing YouTube art tries the alternate size before showing the waveform tile. | Native library UI regression at standard, compact and tall phone sizes. |
| Every matching saved playlist is visible. YouTube Songs, Videos, Albums and Playlists can load more. Native playlists support up to 10,000 tracks. | Catalog/UI and large-playlist regressions. |

Native playback sources remain YouTube and imported local audio. These changes
do not enable iOS video playback. Release artifacts are built from a clean
commit; the Android APK is signed with the existing release key and the iOS
IPA and portable project contain no personal provisioning or device data.
