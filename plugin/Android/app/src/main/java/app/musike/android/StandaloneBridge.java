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
    private static java.lang.ref.WeakReference<MainActivity> activity = new java.lang.ref.WeakReference<>(null);
    public static native void galleryResult(String uri, String name);
    private static native void audioDevicesChanged();
    private static android.os.HandlerThread routeThread;
    private static android.media.AudioDeviceCallback routeCallback;
    static void setActivity(MainActivity value) { activity = new java.lang.ref.WeakReference<>(value); }
    public static boolean pickGallery() { MainActivity current=activity.get();if(current==null)return false;current.runOnUiThread(current::pickGalleryVideo);return true; }
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
    private static native double performanceTouch(int sourceId, int generation, double target, int bank, int pad, boolean sample, boolean looper, boolean enabled, double ageMs);
    private static native void performanceRelease(int bank, int pad, int generation);

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
            final boolean sample,looper;
            Region(JSONObject value) {
                super(value);
                pad=value.optInt("pad",-1); to=value.optDouble("to",0);
                sample=value.optBoolean("sample");
                looper=value.optBoolean("looper");
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
        private final android.util.SparseArray<Receipt> heldLoops=new android.util.SparseArray<>();
        private boolean staleReceipt;
        private void releaseLoops(){for(int i=0;i<heldLoops.size();i++){Receipt receipt=heldLoops.valueAt(i);performanceRelease(receipt.map.bank,receipt.region.pad,receipt.map.generation);}heldLoops.clear();}
        @JavascriptInterface public synchronized void regions(String json) {
            try {
                JSONObject value=new JSONObject(json);
                double id=value.getDouble("clockId"), offset=android.os.SystemClock.uptimeMillis()-value.getDouble("jsTime");
                if(!Double.isFinite(id) || !Double.isFinite(offset)) throw new IllegalArgumentException("Input clock missing");
                if(id!=clockId) { clockId=id; clockOffset=offset; receipts.clear(); }
                else clockOffset=Math.min(clockOffset,offset);
                PadMap next=new PadMap(value,clockOffset),previous=padMap;
                if(previous==null||previous.sourceId!=next.sourceId||previous.generation!=next.generation||previous.bank!=next.bank||!next.enabled)releaseLoops();
                padMap=next;
            }
            catch(Exception ignored) { releaseLoops();padMap=null; }
        }
        @JavascriptInterface public synchronized double consumeTouch(int sourceId, int bank, int pad, boolean sample, double target, double eventTime, boolean looper, boolean ordered) {
            long now=android.os.SystemClock.uptimeMillis();
            staleReceipt=false;
            if(!Double.isFinite(eventTime) || eventTime<0) return Double.NaN;
            java.util.Iterator<Receipt> iterator=receipts.iterator();
            while(iterator.hasNext()) {
                Receipt receipt=iterator.next();
                if(now-receipt.at>60000) { iterator.remove(); continue; }
                // Compare original timestamps, not bridge-call arrival times:
                // renderer/Java scheduling delays must not replay a raw hit.
                if((ordered&&receipt.map.sourceId==sourceId||Math.abs(eventTime-(receipt.at-receipt.map.clockOffset))<=32) && receipt.map.bank==bank && receipt.region.pad==pad) {
                    iterator.remove();
                    if(receipt.map.sourceId==sourceId&&receipt.region.sample==sample&&receipt.region.looper==looper&&(sample||padMap!=null&&padMap.generation==receipt.map.generation)&&(sample||looper||Math.abs(receipt.region.to-target)<.0001))return receipt.origin;
                    staleReceipt=true;return Double.NaN;
                }
            }
            return Double.NaN;
        }
        @JavascriptInterface public synchronized boolean consumedStale(){return staleReceipt;}
        synchronized void touch(android.webkit.WebView view, android.view.MotionEvent event) {
            int action=event.getActionMasked();
            if(action==android.view.MotionEvent.ACTION_CANCEL){releaseLoops();return;}
            if(action==android.view.MotionEvent.ACTION_UP||action==android.view.MotionEvent.ACTION_POINTER_UP){int pointer=event.getPointerId(event.getActionIndex());Receipt held=heldLoops.get(pointer);if(held!=null){heldLoops.remove(pointer);performanceRelease(held.map.bank,held.region.pad,held.map.generation);}return;}
            if(action!=android.view.MotionEvent.ACTION_DOWN && action!=android.view.MotionEvent.ACTION_POINTER_DOWN) return;
            PadMap map=padMap;
            if(map==null || view.getWidth()<=0 || view.getHeight()<=0 || view.getUrl()==null
                || !view.getUrl().startsWith("https://juce.backend/")
                || Math.abs((double)view.getWidth()/view.getHeight()-map.aspect)>.01) return;
            int index=event.getActionIndex();
            int pointer=event.getPointerId(index);if(heldLoops.get(pointer)!=null)return;
            double x=event.getX(index)/view.getWidth(), y=event.getY(index)/view.getHeight();
            for(Bounds hole:map.blocked) if(hole.contains(x,y)) return;
            for(Region region:map.regions) if(region.pad>=0 && region.pad<16 && region.contains(x,y)) {
                double origin=performanceTouch(map.sourceId,map.generation,region.to,map.bank,region.pad,region.sample,region.looper,map.enabled,
                    android.os.SystemClock.uptimeMillis()-event.getEventTime());
                if(Double.isFinite(origin)) synchronized(this) {
                    while(receipts.size()>=256) receipts.removeFirst();
                    Receipt receipt=new Receipt(map,region,origin,event.getEventTime());receipts.addLast(receipt);if(region.looper)heldLoops.put(pointer,receipt);
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

    static void initialise(Context value) {
        context = value.getApplicationContext();routeThread=new android.os.HandlerThread("Beatmaker audio routes");routeThread.start();
        routeCallback=new android.media.AudioDeviceCallback(){@Override public void onAudioDevicesAdded(android.media.AudioDeviceInfo[] devices){audioDevicesChanged();}@Override public void onAudioDevicesRemoved(android.media.AudioDeviceInfo[] devices){audioDevicesChanged();}};
        // Registration follows bind(), after the native library has loaded.
    }
    public static void startAudioDeviceEvents(){if(context!=null&&routeCallback!=null)audio().registerAudioDeviceCallback(routeCallback,new android.os.Handler(routeThread.getLooper()));}
    public static String audioDevices(){
        org.json.JSONArray result=new org.json.JSONArray();if(context==null)return result.toString();
        for(android.media.AudioDeviceInfo port:audio().getDevices(AudioManager.GET_DEVICES_ALL))try{
            int type=port.getType();String suffix=portTypeName(type);if(suffix.isEmpty())continue;
            String product=port.getProductName().toString(),kind=type==15?"microphone":type==2||type==24?"speaker":type==11||type==12||type==22?"usb":"other";
            String address=Build.VERSION.SDK_INT>=28?port.getAddress():"";
            org.json.JSONObject entry=new org.json.JSONObject();entry.put("id",product+" "+suffix);entry.put("deviceId",port.getId());entry.put("stableId",type+":"+address+":"+product);entry.put("name",kind.equals("usb")&&product.toLowerCase(java.util.Locale.ROOT).replaceAll("[ _-]","").contains("sp404")?"SP-404":product+" "+suffix);entry.put("kind",kind);entry.put("type",kind.equals("usb")?"USBAudio":kind.equals("microphone")?"MicrophoneBuiltIn":suffix);entry.put("input",port.isSource());result.put(entry);
        }catch(Exception ignored){}return result.toString();
    }
    private static String portTypeName(int type){switch(type){case 1:return "built-in earphone speaker";case 2:return "built-in speaker";case 3:return "wired headset";case 4:return "wired headphones";case 5:return "line analog";case 6:return "line digital";case 7:return "Bluetooth device typically used for telephony";case 8:return "Bluetooth device supporting the A2DP profile";case 9:return "HDMI";case 10:return "HDMI audio return channel";case 11:return "USB device";case 12:return "USB accessory";case 13:return "DOCK";case 15:return "built-in microphone";case 22:return "USB headset";case 23:return "hearing aid";case 24:return "built-in speaker safe";case 26:return "BLE headset";case 27:return "BLE speaker";default:return "";}}
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
        if(context!=null&&routeCallback!=null)audio().unregisterAudioDeviceCallback(routeCallback);
        if(routeThread!=null)routeThread.quitSafely();routeCallback=null;routeThread=null;
        PlaybackService.nativeListener = null;
        if (context != null) { PlaybackService.shutdown(context); if (Build.VERSION.SDK_INT >= 26 && focus != null) audio().abandonAudioFocusRequest(focus); }
        focused = false; resumeTransient = false;
    }
}
