package app.musike.android;

import android.content.Context;
import android.media.midi.MidiDevice;
import android.media.midi.MidiDeviceInfo;
import android.media.midi.MidiDeviceStatus;
import android.media.midi.MidiManager;
import android.media.midi.MidiOutputPort;
import android.media.midi.MidiReceiver;
import android.os.Handler;
import android.os.Looper;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.IOException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * USB MIDI input for the Android cue pads (web/src/native/midi.ts). Android's WebView has no Web MIDI,
 * so the platform MIDI stack forwards note/CC messages to the cue screen instead.
 */
@CapacitorPlugin(name = "MusikeMidi")
public class MusikeMidiPlugin extends Plugin {

    private MidiManager manager;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final Map<Integer, MidiDevice> devices = new HashMap<>();
    private final Map<Integer, List<MidiOutputPort>> ports = new HashMap<>();
    private final Set<Integer> opening = new HashSet<>();
    private MidiManager.DeviceCallback callback;

    @Override
    public void load() {
        manager = (MidiManager) getContext().getSystemService(Context.MIDI_SERVICE);
        if (manager == null) return;
        callback = new MidiManager.DeviceCallback() {
            @Override
            public void onDeviceAdded(MidiDeviceInfo info) {
                open(info);
                notifyDevices();
            }

            @Override
            public void onDeviceRemoved(MidiDeviceInfo info) {
                close(info.getId());
                notifyDevices();
            }

            @Override
            public void onDeviceStatusChanged(MidiDeviceStatus status) {
                notifyDevices();
            }
        };
        manager.registerDeviceCallback(callback, main);
        refreshDevices();
    }

    @Override
    protected void handleOnDestroy() {
        if (manager != null && callback != null) manager.unregisterDeviceCallback(callback);
        for (Integer id : new ArrayList<>(devices.keySet())) close(id);
    }

    @PluginMethod
    public void list(PluginCall call) {
        call.resolve(deviceList());
    }

    @PluginMethod
    public void refresh(PluginCall call) {
        refreshDevices();
        call.resolve();
    }

    private void refreshDevices() {
        if (manager == null) return;
        for (MidiDeviceInfo info : manager.getDevices()) open(info);
        notifyDevices();
    }

    private JSObject deviceList() {
        JSArray list = new JSArray();
        if (manager != null) {
            for (MidiDeviceInfo info : manager.getDevices()) {
                JSObject device = new JSObject();
                device.put("id", info.getId());
                device.put("name", nameOf(info));
                list.put(device);
            }
        }
        JSObject result = new JSObject();
        result.put("devices", list);
        return result;
    }

    private String nameOf(MidiDeviceInfo info) {
        String name = info.getProperties().getString(MidiDeviceInfo.PROPERTY_NAME);
        if (name != null && !name.isEmpty()) return name;
        if (info.getType() == MidiDeviceInfo.TYPE_USB) return "USB MIDI";
        if (info.getType() == MidiDeviceInfo.TYPE_BLUETOOTH) return "Bluetooth MIDI";
        return "MIDI device";
    }

    private void open(MidiDeviceInfo info) {
        if (manager == null || info.getOutputPortCount() == 0) return;
        int id = info.getId();
        if (devices.containsKey(id) || opening.contains(id)) return;
        opening.add(id);
        manager.openDevice(info, device -> {
            opening.remove(id);
            if (device == null) return;
            if (devices.containsKey(id)) {
                try {
                    device.close();
                } catch (IOException ignored) {}
                return;
            }
            List<MidiOutputPort> opened = new ArrayList<>();
            for (int i = 0; i < info.getOutputPortCount(); i++) {
                MidiOutputPort port = device.openOutputPort(i);
                if (port == null) continue;
                port.connect(new Receiver());
                opened.add(port);
            }
            if (opened.isEmpty()) {
                try {
                    device.close();
                } catch (IOException ignored) {}
                return;
            }
            devices.put(id, device);
            ports.put(id, opened);
            notifyDevices();
        }, main);
    }

    private void close(int id) {
        List<MidiOutputPort> opened = ports.remove(id);
        if (opened != null) {
            for (MidiOutputPort port : opened) {
                try {
                    port.close();
                } catch (IOException ignored) {}
            }
        }
        MidiDevice device = devices.remove(id);
        if (device != null) {
            try {
                device.close();
            } catch (IOException ignored) {}
        }
    }

    private void notifyDevices() {
        JSObject result = deviceList();
        main.post(() -> notifyListeners("devices", result));
    }

    private final class Receiver extends MidiReceiver {

        @Override
        public void onSend(byte[] data, int offset, int count, long timestamp) {
            int i = offset;
            int end = offset + count;
            int status = -1;
            while (i < end) {
                int value = data[i] & 0xff;
                if (value >= 0x80) {
                    status = value;
                    i++;
                    if (status >= 0xf0) {
                        status = -1; // system messages are not used by the cue pads
                        continue;
                    }
                } else if (status < 0) {
                    i++;
                    continue;
                }
                int type = status & 0xf0;
                int length = type == 0xc0 || type == 0xd0 ? 1 : 2;
                if (i + length > end) break;
                int first = data[i] & 0xff;
                int second = length == 2 ? data[i + 1] & 0xff : 0;
                i += length;
                if (type == 0x90 && second > 0) note(status & 0x0f, first, second, true);
                else if (type == 0x80 || type == 0x90) note(status & 0x0f, first, 0, false);
                else if (type == 0xb0) control(status & 0x0f, first, second);
            }
        }
    }

    private void note(int channel, int note, int velocity, boolean on) {
        JSObject message = new JSObject();
        message.put("type", on ? "noteon" : "noteoff");
        message.put("channel", channel);
        message.put("note", note);
        message.put("velocity", velocity);
        main.post(() -> notifyListeners("message", message));
    }

    private void control(int channel, int controller, int value) {
        JSObject message = new JSObject();
        message.put("type", "cc");
        message.put("channel", channel);
        message.put("controller", controller);
        message.put("value", value);
        main.post(() -> notifyListeners("message", message));
    }
}
