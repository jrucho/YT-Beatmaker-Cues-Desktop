package app.musike.android;
import android.content.ContentResolver;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.ImageDecoder;
import android.net.Uri;
import android.os.Build;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;

// JUCE observes ActivityLifecycleCallbacks itself. JuceActivity is the optional
// push-notification activity and calls JNI hooks absent from this target.
public final class MainActivity extends android.app.Activity {
    private static final int PICK_PLAYLIST_IMAGE = 4048;
    private static final int COVER_SIZE = 640;
    private final java.util.WeakHashMap<android.webkit.WebView, Boolean> configuredWebViews = new java.util.WeakHashMap<>();
    @Override protected void onCreate(android.os.Bundle state) {
        super.onCreate(state);
        StandaloneBridge.setActivity(this);
        if (android.os.Build.VERSION.SDK_INT >= 30) getWindow().setDecorFitsSystemWindows(false);
        if (BuildConfig.DEBUG || BuildConfig.LATENCY_PROBE) android.webkit.WebView.setWebContentsDebuggingEnabled(true);
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
            android.webkit.WebView web = (android.webkit.WebView)view;
            if (!configuredWebViews.containsKey(web)) {
                configuredWebViews.put(web, true);
                StandaloneBridge.PerformanceBridge performance = new StandaloneBridge.PerformanceBridge();
                web.addJavascriptInterface(performance, "__beatmakerPerformance");
                web.setOnTouchListener((target,event) -> {performance.touch(web,event);return false;});
                // addJavascriptInterface becomes visible on the next document.
                // A very fast initial load can beat the first layout callback.
                web.evaluateJavascript("typeof window.__beatmakerPerformance", result -> {
                    if ("\"undefined\"".equals(result) && web.getUrl() != null && web.getUrl().startsWith("https://juce.backend/")) web.reload();
                });
            }
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
    void pickGalleryVideo() {
        try {
            android.content.Intent intent=android.os.Build.VERSION.SDK_INT>=33 ? new android.content.Intent(android.provider.MediaStore.ACTION_PICK_IMAGES) : new android.content.Intent(android.content.Intent.ACTION_PICK,android.provider.MediaStore.Video.Media.EXTERNAL_CONTENT_URI);
            intent.setType("video/*");intent.addFlags(android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION);startActivityForResult(intent,4047);
        } catch(Exception error) { StandaloneBridge.galleryResult("",""); }
    }
    void pickPlaylistImage(boolean photos) {
        Intent intent;
        if(photos && Build.VERSION.SDK_INT>=33)
            intent=new Intent(android.provider.MediaStore.ACTION_PICK_IMAGES).setType("image/*");
        else if(photos)
            intent=new Intent(Intent.ACTION_PICK).setDataAndType(android.provider.MediaStore.Images.Media.EXTERNAL_CONTENT_URI,"image/*");
        else
            intent=new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("image/*");
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        try {startActivityForResult(intent,PICK_PLAYLIST_IMAGE);}
        catch(android.content.ActivityNotFoundException unavailable) {
            if(photos)pickPlaylistImage(false);
            else StandaloneBridge.playlistImageResult("",true);
        }
        catch(SecurityException denied){StandaloneBridge.playlistImageResult("",true);}
    }
    private static Bitmap decodeCover(ContentResolver resolver, Uri uri) throws IOException {
        if(Build.VERSION.SDK_INT>=28) {
            return ImageDecoder.decodeBitmap(ImageDecoder.createSource(resolver,uri),(decoder,info,source)->{
                int width=info.getSize().getWidth(),height=info.getSize().getHeight();
                float scale=Math.min(1f,(float)COVER_SIZE/Math.max(width,height));
                decoder.setTargetSize(Math.max(1,Math.round(width*scale)),Math.max(1,Math.round(height*scale)));
                decoder.setAllocator(ImageDecoder.ALLOCATOR_SOFTWARE);
            });
        }
        BitmapFactory.Options options=new BitmapFactory.Options();
        options.inJustDecodeBounds=true;
        try(InputStream input=resolver.openInputStream(uri)){BitmapFactory.decodeStream(input,null,options);}
        if(options.outWidth<1||options.outHeight<1)throw new IOException("Not an image");
        options.inSampleSize=1;
        while(Math.max(options.outWidth,options.outHeight)/options.inSampleSize>COVER_SIZE)options.inSampleSize*=2;
        options.inJustDecodeBounds=false;
        try(InputStream input=resolver.openInputStream(uri)){return BitmapFactory.decodeStream(input,null,options);}
    }
    private void encodePlaylistImage(Uri uri) {
        if(uri==null){StandaloneBridge.playlistImageResult("",false);return;}
        ContentResolver resolver=getContentResolver();
        new Thread(()->{
            Bitmap image=null;
            try {
                image=decodeCover(resolver,uri);
                if(image!=null) {
                    ByteArrayOutputStream bytes=new ByteArrayOutputStream();
                    for(int quality:new int[]{82,66,48,30,15}) {
                        bytes.reset();
                        if(image.compress(Bitmap.CompressFormat.JPEG,quality,bytes)&&bytes.size()<=128*1024) {
                            StandaloneBridge.playlistImageResult("data:image/jpeg;base64,"+
                                android.util.Base64.encodeToString(bytes.toByteArray(),android.util.Base64.NO_WRAP),false);
                            return;
                        }
                    }
                }
            } catch(IOException | RuntimeException ignored) {
                // Report a localized error in the app without exposing the selected URI.
            } finally {if(image!=null)image.recycle();}
            StandaloneBridge.playlistImageResult("",true);
        },"PlaylistCover").start();
    }
    @Override protected void onActivityResult(int request,int result,android.content.Intent data) {
        super.onActivityResult(request,result,data);
        if(request==PICK_PLAYLIST_IMAGE){encodePlaylistImage(result==RESULT_OK&&data!=null?data.getData():null);return;}
        if(request!=4047)return;
        android.net.Uri uri=result==RESULT_OK&&data!=null?data.getData():null;String name="";
        if(uri!=null)try(android.database.Cursor cursor=getContentResolver().query(uri,new String[]{android.provider.OpenableColumns.DISPLAY_NAME},null,null,null)){if(cursor!=null&&cursor.moveToFirst())name=cursor.getString(0);}catch(Exception ignored){}
        StandaloneBridge.galleryResult(uri==null?"":uri.toString(),name==null?"":name);
    }
}
