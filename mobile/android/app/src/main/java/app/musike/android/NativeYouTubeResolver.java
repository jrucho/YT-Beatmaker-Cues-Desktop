package app.musike.android;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import org.json.JSONArray;
import org.json.JSONObject;

/** Resolves upcoming songs without waking the WebView. The same clients are used by the iOS resolver. */
final class NativeYouTubeResolver {
    private static final String AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15";
    private static final String[][] CLIENTS = {{"VISIONOS", "1.02", "101"}, {"ANDROID_VR", "1.60.19", "28"}, {"IOS", "20.10.4", "5"}};
    private String visitor = "";

    JSONObject resolve(String id) throws Exception {
        if (!id.matches("[A-Za-z0-9_-]{11}")) throw new IllegalArgumentException("Invalid track ID");
        if (visitor.isEmpty()) {
            try {
                JSONObject response = post("visitor_id?prettyPrint=false", new JSONObject().put("context", new JSONObject().put("client", client(CLIENTS[0]))), CLIENTS[0]);
                visitor = response.optJSONObject("responseContext").optString("visitorData", "");
            } catch (Exception ignored) {}
        }
        String reason = "YouTube did not return a playable stream";
        for (String[] chosen : CLIENTS) {
            try {
                JSONObject body = new JSONObject().put("videoId", id).put("racyCheckOk", true).put("contentCheckOk", true)
                    .put("context", new JSONObject().put("client", client(chosen)))
                    .put("playbackContext", new JSONObject().put("contentPlaybackContext", new JSONObject().put("html5Preference", "HTML5_PREF_WANTS")));
                JSONObject response = post("player?prettyPrint=false&alt=json", body, chosen);
                JSONObject status = response.optJSONObject("playabilityStatus");
                if (status == null || !"OK".equals(status.optString("status"))) {
                    if (status != null) reason = status.optString("reason", reason);
                    continue;
                }
                JSONObject streaming = response.optJSONObject("streamingData");
                JSONArray formats = streaming == null ? null : streaming.optJSONArray("adaptiveFormats");
                JSONObject best = null;
                if (formats != null) for (int i = 0; i < formats.length(); i++) {
                    JSONObject format = formats.getJSONObject(i);
                    String mime = format.optString("mimeType");
                    if (!mime.startsWith("audio/") || format.optString("url").isEmpty()) continue;
                    boolean aac = mime.startsWith("audio/mp4");
                    boolean oldAac = best != null && best.optString("mimeType").startsWith("audio/mp4");
                    if (best == null || (aac && !oldAac) || (aac == oldAac && format.optLong("bitrate") > best.optLong("bitrate"))) best = format;
                }
                if (best != null) return best;
            } catch (Exception e) { reason = e.getMessage(); }
        }
        throw new IllegalStateException(reason);
    }

    private JSONObject client(String[] chosen) throws Exception {
        JSONObject value = new JSONObject().put("clientName", chosen[0]).put("clientVersion", chosen[1])
            .put("hl", "en").put("gl", "US").put("userAgent", AGENT + ",gzip(gfe)").put("platform", "DESKTOP");
        if (!visitor.isEmpty()) value.put("visitorData", visitor);
        return value;
    }

    private JSONObject post(String path, JSONObject body, String[] chosen) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL("https://www.youtube.com/youtubei/v1/" + path).openConnection();
        try {
            connection.setRequestMethod("POST");
            connection.setConnectTimeout(15000);
            connection.setReadTimeout(15000);
            connection.setDoOutput(true);
            connection.setRequestProperty("Content-Type", "application/json");
            connection.setRequestProperty("User-Agent", AGENT);
            connection.setRequestProperty("Origin", "https://www.youtube.com");
            connection.setRequestProperty("X-YouTube-Client-Name", chosen[2]);
            connection.setRequestProperty("X-YouTube-Client-Version", chosen[1]);
            connection.setRequestProperty("X-Goog-Api-Format-Version", "2");
            byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
            connection.setFixedLengthStreamingMode(bytes.length);
            try (java.io.OutputStream out = connection.getOutputStream()) { out.write(bytes); }
            try (InputStream input = connection.getInputStream(); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
                byte[] buffer = new byte[8192];
                int length;
                while ((length = input.read(buffer)) != -1) out.write(buffer, 0, length);
                return new JSONObject(out.toString("UTF-8"));
            }
        } finally { connection.disconnect(); }
    }
}
