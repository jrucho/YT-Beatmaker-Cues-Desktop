import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";

export interface MidiMessage {
  type: "noteon" | "noteoff" | "cc";
  channel: number;
  note?: number;
  velocity?: number;
  controller?: number;
  value?: number;
}

export interface MidiDevice {
  id: number;
  name: string;
}

interface MidiPlugin {
  list(): Promise<{ devices: MidiDevice[] }>;
  refresh(): Promise<void>;
  addListener(event: "message", fn: (e: MidiMessage) => void): Promise<PluginListenerHandle>;
  addListener(event: "devices", fn: (e: { devices: MidiDevice[] }) => void): Promise<PluginListenerHandle>;
}

const noop = async () => {};
const fallback: MidiPlugin = {
  list: async () => ({ devices: [] }),
  refresh: noop,
  addListener: async () => ({ remove: noop }),
};

export const midi = registerPlugin<MidiPlugin>("MusikeMidi", { web: () => fallback });
export const midiAvailable = Capacitor.isNativePlatform() && Capacitor.isPluginAvailable("MusikeMidi");
