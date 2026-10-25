package app.musike.android;

import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import androidx.media3.common.AudioAttributes;
import androidx.media3.common.C;
import androidx.media3.common.MediaItem;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.PlaybackParameters;
import androidx.media3.common.Player;
import androidx.media3.datasource.DataSpec;
import androidx.media3.datasource.DefaultHttpDataSource;
import androidx.media3.datasource.cache.CacheDataSource;
import androidx.media3.datasource.cache.CacheWriter;
import androidx.media3.datasource.cache.LeastRecentlyUsedCacheEvictor;
import androidx.media3.datasource.cache.SimpleCache;
import androidx.media3.database.StandaloneDatabaseProvider;
import androidx.media3.exoplayer.DefaultLoadControl;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.SeekParameters;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;
import java.io.File;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * The Android side of web/src/lib/audio.ts.
 *
 * The web view's <audio> seeks through YouTube's stream by opening a new connection, which is what made the cue
 * pads feel late. ExoPlayer plays the same URL from the app, keeps it in a local cache, and downloads the rest of
 * the track in the background, so most cue jumps are a read from the phone instead of a network round trip.
 */
@CapacitorPlugin(name = "MusikeAudio")
public class MusikeAudioPlugin extends Plugin {

    /** A desktop Chrome agent: YouTube's stream URLs are served the same bytes to the web player. */
    private static final String USER_AGENT =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
    private static final long CACHE_BYTES = 320L * 1024 * 1024;
    private static final double TICK_SECONDS = 0.25;

    private final Handler main = new Handler(Looper.getMainLooper());
    private ExoPlayer player;
    private CacheDataSource.Factory cacheFactory;
    private static SimpleCache sharedCache;
    private SimpleCache cache;
    private volatile CacheWriter prefetcher;
    private Thread prefetchThread;
    private boolean prefetched;
    private String source = "";
    private int sourceId;
    private boolean metadataSent;
    private double volume = 1;
    private boolean muted;
    private double rate = 1;
    private boolean preservePitch = true;
    private double semitones;
    private long loopFromMs;
    private long loopToMs = -1;
    private static MusikeAudioPlugin active;
    private final PlaylistCursor queue = new PlaylistCursor();
    private final List<JSONObject> tracks = new ArrayList<>();
    private final Map<String, String> resolved = new HashMap<>();
    private final Set<String> resolving = new HashSet<>();
    private final ExecutorService resolverWork = Executors.newSingleThreadExecutor();
    private final NativeYouTubeResolver resolver = new NativeYouTubeResolver();
    private boolean wantPlay;
    private boolean advancing;
    private int transition;
    private long serviceAt;
    private int failedTracks;

    @Override
    public void load() {
        active = this;
        PlaybackService.nativeListener = this::remote;
    }

    static boolean ownsPlayback() { return active != null && !active.source.isEmpty(); }

    private final Runnable loopTicker = new Runnable() {
        @Override
        public void run() {
            if (player == null || loopToMs < 0) return;
            if (player.isPlaying() && player.getCurrentPosition() >= loopToMs) {
                player.seekTo(loopFromMs);
                emitTime();
            }
            main.postDelayed(this, 8);
        }
    };

    private final Runnable ticker = new Runnable() {
        @Override
        public void run() {
            if (player == null) return;
            emitTime();
            main.postDelayed(this, Math.round(TICK_SECONDS * 1000));
        }
    };

    // MARK: - What the web app sends

    @PluginMethod
    public void setSource(PluginCall call) {
        String url = call.getString("url", "");
        int id = call.getInt("sourceId", 0);
        double startAt = call.getDouble("startAt", 0.0);
        JSONObject playlist = call.getObject("queue");
        main.post(() -> {
            transition++;
            advancing = false;
            wantPlay = false;
            replaceQueue(playlist, true);
            open(url, id, startAt);
            if (!queue.current().isEmpty()) resolved.put(queue.current(), url);
            call.resolve();
        });
    }

    @PluginMethod
    public void play(PluginCall call) {
        main.post(() -> {
            wantPlay = true;
            ensurePlayer();
            updateService(true);
            player.play();
        });
        call.resolve();
    }

    @PluginMethod
    public void pause(PluginCall call) {
        main.post(() -> {
            wantPlay = false;
            if (player != null) player.pause();
            updateService(true);
        });
        call.resolve();
    }

    @PluginMethod
    public void seek(PluginCall call) {
        double to = call.getDouble("to", 0.0);
        int id = call.getInt("sourceId", 0);
        main.post(() -> {
            if (player != null && id == sourceId) seekTo(to);
            call.resolve();
        });
    }

    /** One bridge call and one main-thread task: a pad seeks and starts without re-opening the source. */
    @PluginMethod
    public void cue(PluginCall call) {
        double to = call.getDouble("to", 0.0);
        int id = call.getInt("sourceId", 0);
        main.post(() -> {
            if (player != null && id == sourceId) {
                wantPlay = true;
                seekTo(to);
                player.play();
                int pad = call.getInt("pad", 0);
                if (pad >= 1 && pad <= 16) {
                    JSObject feedback = new JSObject();
                    feedback.put("bank", call.getString("bank", "A"));
                    feedback.put("pad", pad);
                    emit("pad", feedback);
                }
            }
            call.resolve();
        });
    }

    private void seekTo(double seconds) {
        if (!Double.isFinite(seconds)) return;
        player.seekTo(Math.max(0, Math.round(seconds * 1000)));
    }

    @PluginMethod
    public void setQueue(PluginCall call) {
        int id = call.getInt("sourceId", 0);
        JSONObject playlist = call.getObject("queue");
        main.post(() -> {
            if (id == sourceId) replaceQueue(playlist, false);
            call.resolve();
        });
    }

    @PluginMethod
    public void snapshot(PluginCall call) {
        main.post(() -> call.resolve(snapshotData()));
    }

    private void replaceQueue(JSONObject value, boolean bind) {
        if (value == null) return;
        JSONArray list = value.optJSONArray("tracks");
        if (list == null) return;
        tracks.clear();
        List<String> ids = new ArrayList<>();
        for (int i = 0; i < list.length(); i++) {
            JSONObject track = list.optJSONObject(i);
            if (track == null) continue;
            tracks.add(track);
            ids.add(track.optString("id"));
        }
        queue.replace(ids, value.optInt("index", 0), value.optString("repeat", "off"), bind);
        if (!bind) warmNext();
    }

    private JSONObject currentTrack() {
        return queue.index >= 0 && queue.index < tracks.size() ? tracks.get(queue.index) : new JSONObject();
    }

    private JSObject loopData() {
        JSObject loop = new JSObject();
        loop.put("from", loopFromMs / 1000.0);
        loop.put("to", loopToMs >= 0 ? loopToMs / 1000.0 : JSONObject.NULL);
        loop.put("on", loopToMs >= 0);
        return loop;
    }

    private JSObject snapshotData() {
        JSObject data = new JSObject();
        data.put("sourceId", sourceId);
        data.put("queueIndex", queue.index);
        data.put("trackId", queue.current());
        data.put("url", source);
        data.put("position", player == null ? 0 : player.getCurrentPosition() / 1000.0);
        data.put("duration", duration());
        data.put("buffered", player == null ? 0 : player.getBufferedPosition() / 1000.0);
        data.put("playing", wantPlay);
        data.put("ready", metadataSent);
        data.put("loop", loopData());
        return data;
    }

    private boolean valid(String url) {
        if (url == null || url.isEmpty()) return false;
        String expires = Uri.parse(url).getQueryParameter("expire");
        try { return expires == null || Long.parseLong(expires) * 1000L > System.currentTimeMillis() + 60000; }
        catch (NumberFormatException e) { return true; }
    }

    private void warmNext() {
        int next = queue.next(false);
        if (next < 0 || next >= tracks.size()) return;
        String id = tracks.get(next).optString("id");
        if (valid(resolved.get(id)) || !resolving.add(id)) return;
        resolverWork.execute(() -> {
            String url = null;
            try { url = resolver.resolve(id).optString("url"); } catch (Exception ignored) {}
            final String result = url;
            main.post(() -> { resolving.remove(id); if (result != null) resolved.put(id, result); });
        });
    }

    private boolean advance(boolean automatic) {
        if (automatic && loopToMs >= 0 && player != null) { player.seekTo(loopFromMs); player.play(); return true; }
        int next = queue.next(automatic);
        if (next < 0) return false;
        if (next == queue.index) { player.seekTo(0); player.play(); return true; }
        startTrack(next);
        return true;
    }

    private void startTrack(int index) {
        queue.index = index;
        final int mine = ++transition;
        final String id = queue.current();
        advancing = true;
        updateService(true);
        String cached = resolved.get(id);
        if (valid(cached)) { beginTrack(cached, mine); return; }
        resolverWork.execute(() -> {
            try {
                String url = resolver.resolve(id).getString("url");
                main.post(() -> { resolved.put(id, url); if (mine == transition) beginTrack(url, mine); });
            } catch (Exception error) {
                main.post(() -> {
                    if (mine != transition) return;
                    advancing = false;
                    failedTracks++;
                    if (failedTracks >= tracks.size() || !advance(false)) {
                        wantPlay = false;
                        JSObject payload = new JSObject(); payload.put("message", error.getMessage());
                        emit("error", payload); updateService(true);
                    }
                });
            }
        });
    }

    private void beginTrack(String url, int mine) {
        if (mine != transition) return;
        failedTracks = 0;
        open(url, sourceId, 0);
        JSONObject loop = currentTrack().optJSONObject("loop");
        if (loop != null && loop.optBoolean("on") && loop.optDouble("to") > loop.optDouble("from")) {
            loopFromMs = Math.round(loop.optDouble("from") * 1000);
            loopToMs = Math.round(loop.optDouble("to") * 1000);
            main.post(loopTicker);
        }
        advancing = false;
        emit("track", snapshotData());
        player.setPlayWhenReady(wantPlay);
        updateService(true);
    }

    private boolean remote(String action, double position) {
        if (source.isEmpty() || player == null) return false;
        switch (action) {
            case "play": wantPlay = true; updateService(true); player.play(); break;
            case "pause": wantPlay = false; player.pause(); updateService(true); break;
            case "toggle": wantPlay = !wantPlay; player.setPlayWhenReady(wantPlay); updateService(true); break;
            case "seek": seekTo(position); break;
            case "next": if (!advance(false)) return false; break;
            case "previous": if (player.getCurrentPosition() > 3000 || queue.index == 0) player.seekTo(0); else startTrack(queue.index - 1); break;
            default: return false;
        }
        return true;
    }

    private void updateService(boolean force) {
        long now = SystemClock.elapsedRealtime();
        if (!force && now - serviceAt < 1000) return;
        serviceAt = now;
        PlaybackService.NowPlaying state = PlaybackService.state;
        JSONObject track = currentTrack();
        state.title = track.optString("title"); state.artist = track.optString("artist");
        state.album = track.optString("album"); state.artwork = track.optString("artwork");
        state.playing = wantPlay;
        state.positionMs = advancing || player == null ? 0 : player.getCurrentPosition();
        state.positionAt = now;
        state.durationMs = advancing ? Math.round(track.optDouble("duration", 0) * 1000) : Math.round(duration() * 1000);
        state.rate = (float) rate;
        PlaybackService.refresh(getContext());
    }

    @PluginMethod
    public void position(PluginCall call) {
        int id = call.getInt("sourceId", 0);
        main.post(() -> {
            if (player == null || id != sourceId) {
                call.reject("Audio source changed");
                return;
            }
            JSObject result = new JSObject();
            result.put("position", player.getCurrentPosition() / 1000.0);
            call.resolve(result);
        });
    }

    @PluginMethod
    public void loop(PluginCall call) {
        int id = call.getInt("sourceId", 0);
        double from = call.getDouble("from", 0.0);
        double to = call.getDouble("to", 0.0);
        boolean on = Boolean.TRUE.equals(call.getBoolean("on", false));
        main.post(() -> {
            if (id == sourceId) {
                loopFromMs = Math.max(0, Math.round(from * 1000));
                loopToMs = on && Double.isFinite(to) && to > from ? Math.round(to * 1000) : -1;
                main.removeCallbacks(loopTicker);
                if (loopToMs >= 0) main.post(loopTicker);
            }
            call.resolve();
        });
    }

    @PluginMethod
    public void volume(PluginCall call) {
        volume = call.getDouble("value", 1.0);
        main.post(this::applyVolume);
        call.resolve();
    }

    @PluginMethod
    public void muted(PluginCall call) {
        muted = Boolean.TRUE.equals(call.getBoolean("value", false));
        main.post(this::applyVolume);
        call.resolve();
    }

    /** Speed and pitch together: varispeed (pitch moves with speed) or pitch kept (only the tempo changes). */
    @PluginMethod
    public void rate(PluginCall call) {
        rate = Math.max(0.1, Math.min(4, call.getDouble("value", 1.0)));
        preservePitch = !Boolean.FALSE.equals(call.getBoolean("preservePitch", true));
        semitones = Math.max(-12, Math.min(12, call.getDouble("semitones", 0.0)));
        main.post(this::applyRate);
        call.resolve();
    }

    // MARK: - Player

    private void ensurePlayer() {
        if (player != null || getContext() == null) return;
        android.content.Context ctx = getContext().getApplicationContext();
        DefaultHttpDataSource.Factory http = new DefaultHttpDataSource.Factory()
                .setUserAgent(USER_AGENT)
                .setAllowCrossProtocolRedirects(true)
                .setConnectTimeoutMs(15000)
                .setReadTimeoutMs(15000);
        DefaultMediaSourceFactory sources;
        try {
            if (cache == null) cache = openCache(ctx);
            cacheFactory = new CacheDataSource.Factory()
                    .setCache(cache)
                    .setUpstreamDataSourceFactory(http)
                    .setFlags(CacheDataSource.FLAG_IGNORE_CACHE_ON_ERROR);
            sources = new DefaultMediaSourceFactory(cacheFactory);
        } catch (Exception e) {
            // A broken cache must not break playback: fall back to streaming directly.
            cache = null;
            cacheFactory = null;
            sources = new DefaultMediaSourceFactory(http);
        }
        player = new ExoPlayer.Builder(ctx)
                .setMediaSourceFactory(sources)
                .setLoadControl(new DefaultLoadControl.Builder()
                        // Start after a quarter second and keep a generous runway for cue jumps.
                        .setBufferDurationsMs(30000, 120000, 250, 500)
                        .setBackBuffer(120000, true)
                        .build())
                .build();
        player.setAudioAttributes(new AudioAttributes.Builder()
                .setUsage(C.USAGE_MEDIA)
                .setContentType(C.AUDIO_CONTENT_TYPE_MUSIC)
                .build(), true);
        player.setHandleAudioBecomingNoisy(true);
        player.setWakeMode(C.WAKE_MODE_LOCAL);
        // A sync point can be the start of an entire audio fragment. CLOSEST_SYNC can therefore turn
        // a cue at five seconds into a jump to zero. Decode to the requested timestamp instead.
        player.setSeekParameters(SeekParameters.EXACT);
        player.addListener(new Player.Listener() {
            @Override
            public void onPlaybackStateChanged(int state) {
                switch (state) {
                    case Player.STATE_READY:
                        if (!metadataSent) {
                            metadataSent = true;
                            emitReady();
                        }
                        emitTime();
                        if (!prefetched) startPrefetch();
                        warmNext();
                        break;
                    case Player.STATE_ENDED:
                        prefetched = false;
                        if (!advance(true)) { wantPlay = false; emit("ended", new JSObject()); updateService(true); }
                        break;
                    default:
                        break;
                }
            }

            @Override
            public void onIsPlayingChanged(boolean playing) {
                if (playing) emit("playing", new JSObject());
                else if (player != null && !player.getPlayWhenReady()) emit("pause", new JSObject());
                updateService(true);
            }

            @Override
            public void onPlayerError(PlaybackException error) {
                JSObject payload = new JSObject();
                payload.put("message", error.getMessage() == null ? "Playback failed" : error.getMessage());
                emit("error", payload);
            }

            @Override
            public void onPositionDiscontinuity(Player.PositionInfo oldPosition, Player.PositionInfo newPosition, int reason) {
                if (reason == Player.DISCONTINUITY_REASON_SEEK) emitSeeked(newPosition.positionMs / 1000.0);
            }
        });
        applyVolume();
        applyRate();
        main.removeCallbacks(ticker);
        main.postDelayed(ticker, Math.round(TICK_SECONDS * 1000));
    }

    /** One cache per process: reopening the folder while the old instance lives makes SimpleCache throw. */
    private SimpleCache openCache(android.content.Context ctx) {
        synchronized (MusikeAudioPlugin.class) {
            if (sharedCache == null) {
                File dir = new File(ctx.getCacheDir(), "audio-cache");
                sharedCache = new SimpleCache(dir, new LeastRecentlyUsedCacheEvictor(CACHE_BYTES), new StandaloneDatabaseProvider(ctx));
            }
            return sharedCache;
        }
    }

    private void open(String url, int id, double startAt) {
        main.removeCallbacks(loopTicker);
        loopToMs = -1;
        sourceId = id;
        source = url;
        metadataSent = false;
        prefetched = false;
        stopPrefetch();
        ensurePlayer();
        if (player == null) return;
        player.stop();
        player.clearMediaItems();
        if (url.isEmpty()) return;
        MediaItem item = new MediaItem.Builder().setUri(url).setCustomCacheKey(queue.current().isEmpty() ? url : queue.current()).build();
        player.setMediaItem(item, Double.isFinite(startAt) ? Math.max(0, Math.round(startAt * 1000)) : 0);
        applyRate();
        player.prepare();
        player.setPlayWhenReady(wantPlay);
    }

    private void applyVolume() {
        if (player != null) player.setVolume(muted ? 0f : (float) Math.max(0, Math.min(1, volume)));
    }

    private void applyRate() {
        if (player == null) return;
        float speed = (float) rate;
        float pitch = preservePitch ? (float) Math.pow(2, semitones / 12.0) : speed;
        player.setPlaybackParameters(new PlaybackParameters(speed, pitch));
    }

    /**
     * Downloads the whole track into the cache after playback starts. Done after READY so it never races the
     * first bytes the player needs; once it finishes, every cue jump is local.
     */
    private void startPrefetch() {
        if (cacheFactory == null || source.isEmpty()) return;
        prefetched = true;
        final String url = source;
        final CacheWriter writer = new CacheWriter(cacheFactory.createDataSource(), new DataSpec.Builder().setUri(Uri.parse(url)).setKey(queue.current().isEmpty() ? url : queue.current()).build(), null, null);
        prefetcher = writer;
        Thread thread = new Thread(() -> {
            try {
                writer.cache();
            } catch (Exception ignored) {
                // Cancelled (track changed) or offline: playback keeps going through the cache data source.
            } finally {
                if (prefetcher == writer) prefetcher = null;
            }
        }, "musike-audio-prefetch");
        thread.setDaemon(true);
        prefetchThread = thread;
        thread.start();
    }

    private void stopPrefetch() {
        CacheWriter writer = prefetcher;
        prefetcher = null;
        if (writer != null) writer.cancel();
        Thread thread = prefetchThread;
        prefetchThread = null;
        if (thread != null) thread.interrupt();
    }

    // MARK: - Events

    private void emitReady() {
        JSObject payload = new JSObject();
        payload.put("duration", duration());
        emit("ready", payload);
    }

    private void emitSeeked(double position) {
        JSObject payload = new JSObject();
        payload.put("position", position);
        payload.put("duration", duration());
        emit("seeked", payload);
    }

    private void emitTime() {
        if (player == null) return;
        updateService(false);
        JSObject payload = new JSObject();
        payload.put("position", player.getCurrentPosition() / 1000.0);
        payload.put("duration", duration());
        payload.put("buffered", player.getBufferedPosition() / 1000.0);
        emit("time", payload);
    }

    private double duration() {
        if (player == null) return 0;
        long ms = player.getDuration();
        return ms == C.TIME_UNSET ? 0 : ms / 1000.0;
    }

    private void emit(String event, JSObject payload) {
        payload.put("event", event);
        payload.put("sourceId", sourceId);
        notifyListeners("event", payload);
    }

    @Override
    protected void handleOnDestroy() {
        if (active == this) { active = null; PlaybackService.nativeListener = null; }
        transition++;
        resolverWork.shutdownNow();
        main.removeCallbacks(ticker);
        main.removeCallbacks(loopTicker);
        stopPrefetch();
        ExoPlayer p = player;
        player = null;
        if (p != null) main.post(p::release);
    }
}
