package app.musike.android;

import android.content.Context;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.os.Build;
import android.webkit.JavascriptInterface;
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
    private static native boolean performance(int action, int sourceId, double value, int bank, int pad);
    private static native double performancePosition(int sourceId);
    private static native double performanceTouch(int sourceId, int generation, double target, int bank, int pad, boolean sample, boolean enabled, double ageMs);

    /** Audio-only interface: no JSON parsing or UI-thread round trip for a hit. */
    public static final class PerformanceBridge {
        private static class Bounds {
            final double x, y, w, h;
            Bounds(JSONObject value) {
                x=value.optDouble("x"); y=value.optDouble("y");
                w=value.optDouble("w"); h=value.optDouble("h");
            }
            boolean contains(double px, double py) {
                return w>0 && h>0 && px>=x && px<x+w && py>=y && py<y+h;
            }
        }
        private static final class Region extends Bounds {
            final int pad;
            final double to;
            final boolean sample;
            Region(JSONObject value) {
                super(value);
                pad=value.optInt("pad",-1); to=value.optDouble("to",0);
                sample=value.optBoolean("sample");
            }
        }
        private static final class PadMap {
            final int sourceId, generation, bank;
            final boolean enabled;
            final double aspect, clockOffset;
            final Region[] regions;
            final Bounds[] blocked;
            PadMap(JSONObject value, double offset) throws Exception {
                sourceId=value.getInt("sourceId"); generation=value.optInt("generation",-1);
                bank=value.getInt("bank"); enabled=value.optBoolean("enabled");
                aspect=value.getDouble("aspect");
                clockOffset=offset;
                org.json.JSONArray rows=value.getJSONArray("pads");
                regions=new Region[Math.min(16,rows.length())];
                for(int i=0;i<regions.length;i++) regions[i]=new Region(rows.getJSONObject(i));
                org.json.JSONArray holes=value.getJSONArray("blocked");
                blocked=new Bounds[Math.min(32,holes.length())];
                for(int i=0;i<blocked.length;i++) blocked[i]=new Bounds(holes.getJSONObject(i));
            }
        }
        private static final class Receipt {
            final PadMap map;
            final Region region;
            final double origin;
            final long at;
            Receipt(PadMap value, Region pad, double position, long time) {
                map=value; region=pad; origin=position; at=time;
            }
        }
        private volatile PadMap padMap;
        private double clockId=Double.NaN, clockOffset=Double.POSITIVE_INFINITY;
        private final java.util.ArrayDeque<Receipt> receipts = new java.util.ArrayDeque<>();
        @JavascriptInterface public synchronized void regions(String json) {
            try {
                JSONObject value=new JSONObject(json);
                double id=value.getDouble("clockId"), offset=android.os.SystemClock.uptimeMillis()-value.getDouble("jsTime");
                if(!Double.isFinite(id) || !Double.isFinite(offset)) throw new IllegalArgumentException("Input clock missing");
                if(id!=clockId) { clockId=id; clockOffset=offset; receipts.clear(); }
                else clockOffset=Math.min(clockOffset,offset);
                padMap=new PadMap(value,clockOffset);
            }
            catch(Exception ignored) { padMap=null; }
        }
        @JavascriptInterface public synchronized double consumeTouch(int sourceId, int bank, int pad, boolean sample, double target, double eventTime) {
            long now=android.os.SystemClock.uptimeMillis();
            if(!Double.isFinite(eventTime) || eventTime<0) return Double.NaN;
            java.util.Iterator<Receipt> iterator=receipts.iterator();
            while(iterator.hasNext()) {
                Receipt receipt=iterator.next();
                if(now-receipt.at>60000) { iterator.remove(); continue; }
                // Compare original timestamps, not bridge-call arrival times:
                // renderer/Java scheduling delays must not replay a raw hit.
                if(Math.abs(eventTime-(receipt.at-receipt.map.clockOffset))<=32 && receipt.map.sourceId==sourceId && receipt.map.bank==bank && receipt.region.pad==pad) {
                    iterator.remove();
                    if(receipt.region.sample==sample && (sample || Math.abs(receipt.region.to-target)<.0001)) return receipt.origin;
                }
            }
            return Double.NaN;
        }
        void touch(android.webkit.WebView view, android.view.MotionEvent event) {
            int action=event.getActionMasked();
            if(action!=android.view.MotionEvent.ACTION_DOWN && action!=android.view.MotionEvent.ACTION_POINTER_DOWN) return;
            PadMap map=padMap;
            if(map==null || view.getWidth()<=0 || view.getHeight()<=0 || view.getUrl()==null
                || !view.getUrl().startsWith("https://juce.backend/")
                || Math.abs((double)view.getWidth()/view.getHeight()-map.aspect)>.01) return;
            int index=event.getActionIndex();
            double x=event.getX(index)/view.getWidth(), y=event.getY(index)/view.getHeight();
            for(Bounds hole:map.blocked) if(hole.contains(x,y)) return;
            for(Region region:map.regions) if(region.pad>=0 && region.pad<16 && region.contains(x,y)) {
                double origin=performanceTouch(map.sourceId,map.generation,region.to,map.bank,region.pad,region.sample,map.enabled,
                    android.os.SystemClock.uptimeMillis()-event.getEventTime());
                if(Double.isFinite(origin)) synchronized(this) {
                    while(receipts.size()>=256) receipts.removeFirst();
                    receipts.addLast(new Receipt(map,region,origin,event.getEventTime()));
                }
                return;
            }
        }
        @JavascriptInterface public boolean audio(int action, int sourceId, double value, int bank, int pad) {
            return performance(action, sourceId, value, bank, pad);
        }
        @JavascriptInterface public double position(int sourceId) { return performancePosition(sourceId); }
        @JavascriptInterface public boolean bufferBursts(int count) {
            return BuildConfig.LATENCY_PROBE && performance(5, 0, count, 0, 0);
        }
        @JavascriptInterface public boolean outputMode(int mode) {
            return BuildConfig.LATENCY_PROBE && performance(6, 0, mode, 0, 0);
        }
    }
    public static int nativeSampleRate() {
        if (context == null) return 0;
        try { return Integer.parseInt(audio().getProperty(AudioManager.PROPERTY_OUTPUT_SAMPLE_RATE)); }
        catch (Exception ignored) { return 0; }
    }

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
