package app.musike.android;

import java.util.ArrayList;
import java.util.List;

/** Pure queue policy, independent of WebView callbacks and Android lifecycle. */
public final class PlaylistCursor {
    private List<String> ids = new ArrayList<>();
    public int index;
    public String repeat = "off";

    public void replace(List<String> next, int requested, String mode, boolean bind) {
        String current = current();
        int oldIndex = index;
        ids = new ArrayList<>(next);
        repeat = mode;
        if (bind) index = Math.max(0, Math.min(requested, ids.size() - 1));
        else if (oldIndex < ids.size() && ids.get(oldIndex).equals(current)) index = oldIndex;
        else index = Math.max(0, ids.indexOf(current));
    }

    public String current() { return index >= 0 && index < ids.size() ? ids.get(index) : ""; }
    public int next(boolean automatic) {
        if (ids.isEmpty()) return -1;
        if (automatic && "one".equals(repeat)) return index;
        if (index + 1 < ids.size()) return index + 1;
        return "all".equals(repeat) ? 0 : -1;
    }
}
