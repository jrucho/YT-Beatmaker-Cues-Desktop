package app.musike.android;

import android.content.Context;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.os.Build;
import org.json.JSONObject;

/** Platform shell only: audio, cues, decoding and queue ownership stay in C++. */
public final class StandaloneBridge {
    private static Context context;
    private static boolean background, focused, resumeTransient;
    private static int interruptedRevision;
    private static AudioFocusRequest focus;
    public static native void bind(Context context);
    static native void setInsets(int left, int top, int right, int bottom);
    private static native void background(boolean value);
    public static native boolean transport(String action, double position);
    private static native String snapshot();

    static void initialise(Context value) { context = value.getApplicationContext(); }
    static void setBackground(boolean value) { background = value; background(value); }
    public static boolean isBackground() { return background; }
    private static AudioManager audio() { return (AudioManager) context.getSystemService(Context.AUDIO_SERVICE); }
    public static void publish(String json) {
        if (context == null) return;
        try {
            JSONObject value = new JSONObject(json);
            PlaybackService.nativeListener = (action, position) -> {
                if (action.equals("pause")) resumeTransient = false;
                return transport(action, position);
            };
            PlaybackService.NowPlaying state = PlaybackService.state;
            state.title = value.optString("title", ""); state.artist = value.optString("artist", ""); state.album = value.optString("album", ""); state.artwork = value.optString("artwork", "");
            state.positionMs = Math.max(0, Math.round(value.optDouble("position") * 1000)); state.durationMs = Math.max(0, Math.round(value.optDouble("duration") * 1000));
            state.positionAt = android.os.SystemClock.elapsedRealtime(); state.playing = value.optBoolean("wantedPlaying"); state.rate = (float) value.optDouble("playbackRate", 0);
            PlaybackService.refresh(context);
            if (state.playing && !focused) requestFocus();
        } catch (Exception error) { android.util.Log.w("BeatmakerStandalone", "Native media snapshot", error); }
    }
    private static void requestFocus() {
        AudioManager.OnAudioFocusChangeListener listener = change -> {
            if (change == AudioManager.AUDIOFOCUS_GAIN) {
                focused = true;
                try { if (resumeTransient && new JSONObject(snapshot()).optInt("playIntentRevision") == interruptedRevision) transport("play", 0); } catch (Exception ignored) {}
                resumeTransient = false;
            } else if (change == AudioManager.AUDIOFOCUS_LOSS || change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT || change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK) {
                focused = false; resumeTransient = change != AudioManager.AUDIOFOCUS_LOSS && PlaybackService.state.playing;
                transport("pause", 0);
                try { interruptedRevision = new JSONObject(snapshot()).optInt("playIntentRevision"); } catch (Exception ignored) { resumeTransient = false; }
            }
        };
        int result;
        if (Build.VERSION.SDK_INT >= 26) {
            if (focus == null) focus = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN).setAudioAttributes(new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_MUSIC).build()).setOnAudioFocusChangeListener(listener).build();
            result = audio().requestAudioFocus(focus);
        } else result = audio().requestAudioFocus(listener, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN);
        focused = result == AudioManager.AUDIOFOCUS_REQUEST_GRANTED;
        if (!focused) transport("pause", 0);
    }
    public static void shutdown() {
        PlaybackService.nativeListener = null;
        if (context != null) { PlaybackService.shutdown(context); if (Build.VERSION.SDK_INT >= 26 && focus != null) audio().abandonAudioFocusRequest(focus); }
        focused = false; resumeTransient = false;
    }
}
