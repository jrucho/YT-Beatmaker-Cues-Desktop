"""Compile-time extension guards for JUCE 8.0.12 on Xcode 27.

JUCE already tests extension status at runtime in these paths. Xcode 27 also
requires app-only APIs to be absent at compile time. AUv3 must let its host own
application lifetime, background tasks, idle-timer policy and orientation.
The guards below leave standalone and desktop behavior intact and keep
APPLICATION_EXTENSION_API_ONLY=YES on the AUv3 target.
"""
from pathlib import Path
import sys

root = Path(sys.argv[1]) / "modules"
marker = "BEATMAKER_EXTENSION_GUARDS"


def patch(relative, replacements):
    path = root / relative
    text = path.read_text()
    if marker in text:
        updated = text.replace("__APPLICATION_EXTENSION__", "BEATMAKER_AUV3_EXTENSION")
        if updated != text:
            path.write_text(updated)
        return
    for before, after in replacements:
        if before not in text:
            raise RuntimeError(f"JUCE source changed: missing patch anchor in {relative}")
        text = text.replace(before, after, 1)
    path.write_text("// " + marker + "\n" + text.replace("__APPLICATION_EXTENSION__", "BEATMAKER_AUV3_EXTENSION"))


patch("juce_events/native/juce_MessageManager_ios.mm", [
    ("void MessageManager::stopDispatchLoop()\n{", "void MessageManager::stopDispatchLoop()\n{\n#if defined(__APPLICATION_EXTENSION__)\n    quitMessagePosted.set (1);\n#else"),
    ("    exit (0); // iOS apps get no mercy", "    exit (0); // iOS apps get no mercy\n#endif"),
])
patch("juce_gui_basics/native/juce_Windowing_ios.mm", [
    ("            app.applicationIconBadgeNumber = 0;", "#if !defined(__APPLICATION_EXTENSION__)\n            app.applicationIconBadgeNumber = 0;\n#else\n            ignoreUnused (app);\n#endif"),
    ("            if (task != UIBackgroundTaskInvalid)\n                [[UIApplication sharedApplication] endBackgroundTask:task];", "#if !defined(__APPLICATION_EXTENSION__)\n            if (task != UIBackgroundTaskInvalid)\n                [[UIApplication sharedApplication] endBackgroundTask:task];\n#endif"),
    ("            ifelse_17_0<BadgeUpdateTrait> ([UIApplication sharedApplication]);", "#if !defined(__APPLICATION_EXTENSION__)\n            ifelse_17_0<BadgeUpdateTrait> ([UIApplication sharedApplication]);\n#endif"),
    ("#if JUCE_EXECUTE_APP_SUSPEND_ON_BACKGROUND_TASK", "#if JUCE_EXECUTE_APP_SUSPEND_ON_BACKGROUND_TASK && !defined(__APPLICATION_EXTENSION__)"),
    ("    if (! SystemStats::isRunningInAppExtensionSandbox())\n        [[UIApplication sharedApplication] setIdleTimerDisabled: ! isEnabled];", "#if !defined(__APPLICATION_EXTENSION__)\n    if (! SystemStats::isRunningInAppExtensionSandbox())\n        [[UIApplication sharedApplication] setIdleTimerDisabled: ! isEnabled];\n#else\n    ignoreUnused (isEnabled);\n#endif"),
    ("    return ! [[UIApplication sharedApplication] isIdleTimerDisabled];", "#if defined(__APPLICATION_EXTENSION__)\n    return true;\n#else\n    return ! [[UIApplication sharedApplication] isIdleTimerDisabled];\n#endif"),
])
patch("juce_gui_basics/native/juce_UIViewComponentPeer_ios.mm", [
    ("static UIInterfaceOrientation getWindowOrientation()\n{", "static UIInterfaceOrientation getWindowOrientation()\n{\n#if defined(__APPLICATION_EXTENSION__)\n    return UIInterfaceOrientationPortrait;\n#else"),
    ("    return [sharedApplication statusBarOrientation];\n    JUCE_END_IGNORE_DEPRECATION_WARNINGS", "    return [sharedApplication statusBarOrientation];\n    JUCE_END_IGNORE_DEPRECATION_WARNINGS\n#endif"),
    ("void Desktop::allowedOrientationsChanged()\n{", "void Desktop::allowedOrientationsChanged()\n{\n#if !defined(__APPLICATION_EXTENSION__)"),
    ("        [value release];\n    }\n}", "        [value release];\n    }\n#endif\n}"),
])
patch("juce_core/native/juce_Files_mac.mm", [
    ("        [[UIApplication sharedApplication] openURL: filenameAsURL\n                                           options: @{}\n                                 completionHandler: nil];\n\n        return true;", "#if defined(BEATMAKER_AUV3_EXTENSION)\n        return false; // An extension cannot open external apps.\n#else\n        [[UIApplication sharedApplication] openURL: filenameAsURL\n                                           options: @{}\n                                 completionHandler: nil];\n        return true;\n#endif"),
])
patch("juce_core/native/juce_Threads_mac.mm", [
    ("       #elif JUCE_IOS\n        [[UIApplication sharedApplication] performSelector: @selector (suspend)];", "       #elif JUCE_IOS && !defined(BEATMAKER_AUV3_EXTENSION)\n        [[UIApplication sharedApplication] performSelector: @selector (suspend)];"),
])
print("JUCE iOS extension guards ready (host owns application lifecycle/orientation)")
