package app.musike.android;
// JUCE observes ActivityLifecycleCallbacks itself. JuceActivity is the optional
// push-notification activity and calls JNI hooks absent from this target.
public final class MainActivity extends android.app.Activity {
    @Override protected void onCreate(android.os.Bundle state) {
        super.onCreate(state);
        if (android.os.Build.VERSION.SDK_INT >= 30) getWindow().setDecorFitsSystemWindows(false);
        if (BuildConfig.DEBUG) android.webkit.WebView.setWebContentsDebuggingEnabled(true);
        android.view.View decor = getWindow().getDecorView();
        decor.setBackgroundColor(android.graphics.Color.BLACK);
        decor.getViewTreeObserver().addOnGlobalLayoutListener(() -> configureWebViews(decor));
        decor.setOnApplyWindowInsetsListener((view, insets) -> {
            publishInsets(insets);
            return insets;
        });
        publishInsets(null);
        decor.requestApplyInsets();
    }
    private void configureWebViews(android.view.View view) {
        if (view instanceof android.webkit.WebView) {
            view.setBackgroundColor(android.graphics.Color.BLACK);
            view.setVerticalScrollBarEnabled(false);
            view.setHorizontalScrollBarEnabled(false);
            view.setOverScrollMode(android.view.View.OVER_SCROLL_NEVER);
        } else if (view instanceof android.view.ViewGroup) {
            android.view.ViewGroup group = (android.view.ViewGroup)view;
            for (int i = 0; i < group.getChildCount(); i++) configureWebViews(group.getChildAt(i));
        }
    }
    private void publishInsets(android.view.WindowInsets insets) {
            int left = 0, top = 0, right = 0, bottom = 0;
            if (android.os.Build.VERSION.SDK_INT >= 30) {
                // Window metrics retain cutout/system-bar geometry in kiosk mode.
                android.graphics.Insets safe = getWindowManager().getCurrentWindowMetrics().getWindowInsets().getInsetsIgnoringVisibility(
                    android.view.WindowInsets.Type.systemBars() | android.view.WindowInsets.Type.displayCutout());
                left = safe.left; top = safe.top; right = safe.right; bottom = safe.bottom;
            } else if (insets != null) {
                left = insets.getStableInsetLeft(); top = insets.getStableInsetTop();
                right = insets.getStableInsetRight(); bottom = insets.getStableInsetBottom();
                if (android.os.Build.VERSION.SDK_INT >= 28 && insets.getDisplayCutout() != null) {
                    android.view.DisplayCutout cutout = insets.getDisplayCutout();
                    left = Math.max(left, cutout.getSafeInsetLeft()); top = Math.max(top, cutout.getSafeInsetTop());
                    right = Math.max(right, cutout.getSafeInsetRight()); bottom = Math.max(bottom, cutout.getSafeInsetBottom());
                }
            }
            int statusBar = getResources().getIdentifier("status_bar_height", "dimen", "android");
            if (statusBar != 0) top = Math.max(top, getResources().getDimensionPixelSize(statusBar));
            StandaloneBridge.setInsets(left, top, right, bottom);
    }
    @Override protected void onPause() { StandaloneBridge.setBackground(true); super.onPause(); }
    @Override protected void onResume() {
        super.onResume(); StandaloneBridge.setBackground(false);
        getWindow().getDecorView().post(() -> publishInsets(getWindow().getDecorView().getRootWindowInsets()));
    }
    @Override public void onConfigurationChanged(android.content.res.Configuration configuration) {
        super.onConfigurationChanged(configuration);
        getWindow().getDecorView().post(() -> publishInsets(getWindow().getDecorView().getRootWindowInsets()));
    }
}
