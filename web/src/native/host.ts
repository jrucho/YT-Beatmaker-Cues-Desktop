declare global {
  interface Window {
    /** Set by the native bridge for VST3/AU/AUv3, never for standalone apps. */
    __pluginHosted?: boolean;
    /** Shared library operations are provided by the native app or instrument host. */
    __pluginLibraryTools?: boolean;
  }
}

/** Letter/transport shortcuts belong to the DAW; number-pad shortcuts stay active. */
export const playerShortcutsEnabled = () => window.__pluginHosted !== true;

export const nativeLibraryToolsEnabled = () => typeof window !== "undefined" && window.__pluginLibraryTools === true;
export const playlistPhotosEnabled = () => nativeLibraryToolsEnabled() &&
  (window.__pluginPlatform === "ios" || window.__pluginPlatform === "android");
