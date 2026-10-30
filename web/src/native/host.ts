declare global {
  interface Window {
    /** Set by the native bridge for VST3/AU/AUv3, never for standalone apps. */
    __pluginHosted?: boolean;
  }
}

/** Letter/transport shortcuts belong to the DAW; number-pad shortcuts stay active. */
export const playerShortcutsEnabled = () => window.__pluginHosted !== true;
