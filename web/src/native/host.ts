declare global {
  interface Window {
    /** Set by the native bridge for VST3/AU/AUv3, never for standalone apps. */
    __pluginHosted?: boolean;
  }
}

/** Leave the computer keyboard to the DAW's transport and virtual MIDI keyboard. */
export const playerShortcutsEnabled = () => window.__pluginHosted !== true;
