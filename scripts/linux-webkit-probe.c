/*
 * Report whether the runtime pieces JUCE's Linux WebView needs are actually
 * loadable, and prove that WebKitGTK can load a document and execute
 * JavaScript in this display/session environment.
 *
 * JUCE dlopens unversioned library names and silently disables the browser if
 * any of them are missing, which looks like a hang in higher-level tests.
 * Exit status 0 means: libraries loaded, document loaded, JavaScript ran.
 */
#include <dlfcn.h>
#include <gtk/gtk.h>
#include <gtk/gtkx.h>
#include <stdio.h>
#include <string.h>
#include <webkit2/webkit2.h>

static int load_libraries(void) {
    const char* names[] = {
        "libwebkit2gtk-4.1.so", "libjavascriptcoregtk-4.1.so", "libsoup-3.0.so",
        "libgtk-3.so", "libglib-2.0.so", NULL
    };
    int failures = 0;
    for (int i = 0; names[i] != NULL; ++i) {
        void* handle = dlopen(names[i], RTLD_LAZY);
        fprintf(stderr, "[probe] dlopen %-32s %s%s%s\n", names[i],
                handle ? "ok" : "FAILED: ",
                handle ? "" : dlerror(),
                "");
        if (handle == NULL) ++failures;
    }
    return failures;
}

typedef struct {
    gboolean loaded;
    gboolean evaluated;
    char* value;
    char* error;
} Probe;

static void on_load_changed(WebKitWebView* view, WebKitLoadEvent event, gpointer data) {
    (void)view;
    if (event == WEBKIT_LOAD_FINISHED) ((Probe*)data)->loaded = TRUE;
}

static void on_javascript(WebKitWebView* view, GAsyncResult* result, gpointer data) {
    Probe* probe = (Probe*)data;
    GError* error = NULL;
    JSCValue* value = webkit_web_view_evaluate_javascript_finish(view, result, &error);
    if (error != NULL) {
        probe->error = g_strdup(error->message);
        g_error_free(error);
    } else if (value != NULL) {
        probe->value = jsc_value_to_string(value);
        g_object_unref(value);
    }
    probe->evaluated = TRUE;
}

static void pump(Probe* probe, gboolean* done) {
    for (int i = 0; i < 600 && !*done; ++i) {
        gtk_main_iteration_do(FALSE);
        g_usleep(10000);
    }
}

int main(int argc, char** argv) {
    setvbuf(stderr, NULL, _IONBF, 0);
    setvbuf(stdout, NULL, _IONBF, 0);

    /* JUCE's Linux child launcher extracts a helper binary that dlopens the
       current executable and looks up juce_gtkWebkitMain in it. Reproduce that
       exact step so a failed launch is visible instead of a silent no-op. */
    if (argc == 3 && strcmp(argv[1], "--dlopen-check") == 0) {
        void* handle = dlopen(argv[2], RTLD_LAZY);
        fprintf(stderr, "[probe] dlopen(%s): %s%s\n", argv[2],
                handle ? "ok" : "FAILED: ", handle ? "" : dlerror());
        if (handle == NULL) return 7;
        void* symbol = dlsym(handle, "juce_gtkWebkitMain");
        fprintf(stderr, "[probe] dlsym(juce_gtkWebkitMain): %s%s\n",
                symbol ? "ok" : "FAILED: ", symbol ? "" : dlerror());
        return symbol != NULL ? 0 : 8;
    }

    if (load_libraries() != 0) return 2;

    fprintf(stderr, "[probe] webkit %u.%u.%u\n",
            webkit_get_major_version(), webkit_get_minor_version(), webkit_get_micro_version());

    if (!gtk_init_check(NULL, NULL)) {
        fprintf(stderr, "[probe] no display\n");
        return 3;
    }

    WebKitSettings* settings = webkit_settings_new();
    webkit_settings_set_hardware_acceleration_policy(
        settings, WEBKIT_HARDWARE_ACCELERATION_POLICY_NEVER);

    /* Mirror JUCE's GtkPlug embedding: the plug only becomes realised once the
       widget tree is shown, exactly like the real browser component. */
    GtkWidget* plug = gtk_plug_new(0);
    GtkWidget* scrolled = gtk_scrolled_window_new(NULL, NULL);
    GtkWidget* view = webkit_web_view_new_with_settings(settings);
    gtk_container_add(GTK_CONTAINER(scrolled), view);
    gtk_container_add(GTK_CONTAINER(plug), scrolled);
    gtk_widget_show_all(plug);
    fprintf(stderr, "[probe] plug id %lu\n", gtk_plug_get_id(GTK_PLUG(plug)));

    Probe* probe = g_new0(Probe, 1);
    g_signal_connect(view, "load-changed", G_CALLBACK(on_load_changed), probe);
    webkit_web_view_load_html(WEBKIT_WEB_VIEW(view), "<html><body><p id=\"probe\">ready</p></body></html>", NULL);

    pump(probe, &probe->loaded);
    if (!probe->loaded) {
        fprintf(stderr, "[probe] document load FAILED\n");
        return 4;
    }
    fprintf(stderr, "[probe] document loaded\n");

    webkit_web_view_evaluate_javascript(
        WEBKIT_WEB_VIEW(view), "document.getElementById('probe').textContent + ':' + (1 + 1)",
        -1, NULL, NULL, NULL, (GAsyncReadyCallback)on_javascript, probe);

    pump(probe, &probe->evaluated);
    if (!probe->evaluated) {
        fprintf(stderr, "[probe] JavaScript FAILED to return\n");
        return 5;
    }
    if (probe->error != NULL) {
        fprintf(stderr, "[probe] JavaScript error: %s\n", probe->error);
        return 6;
    }
    fprintf(stderr, "[probe] JavaScript returned: %s\n", probe->value ? probe->value : "(null)");
    printf("PASS: WebKitGTK document load and JavaScript execution\n");
    return 0;
}
