package app.musike.android;
// JUCE observes ActivityLifecycleCallbacks itself. JuceActivity is the optional
// push-notification activity and calls JNI hooks absent from this target.
public final class MainActivity extends android.app.Activity {
    @Override protected void onCreate(android.os.Bundle state) {
        super.onCreate(state);
        if (android.os.Build.VERSION.SDK_INT >= 30) getWindow().setDecorFitsSystemWindows(false);
        if (BuildConfig.DEBUG) android.webkit.WebView.setWebContentsDebuggingEnabled(true);
    }
    @Override protected void onPause() { StandaloneBridge.setBackground(true); super.onPause(); }
    @Override protected void onResume() { super.onResume(); StandaloneBridge.setBackground(false); }
}
