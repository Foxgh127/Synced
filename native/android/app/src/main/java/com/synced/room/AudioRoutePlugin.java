package com.synced.room;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.media.AudioAttributes;
import android.media.AudioDeviceCallback;
import android.media.AudioDeviceInfo;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;

import androidx.annotation.RequiresApi;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.util.List;

@CapacitorPlugin(
    name = "AudioRoute",
    permissions = {
        @Permission(
            alias = "bluetoothConnect",
            strings = { Manifest.permission.BLUETOOTH_CONNECT }
        )
    }
)
public class AudioRoutePlugin extends Plugin {
    private AudioManager audioManager;
    private AudioDeviceCallback audioDeviceCallback;
    private AudioFocusRequest audioFocusRequest;
    private Handler mainHandler;
    private int previousMode = AudioManager.MODE_NORMAL;
    private boolean voiceActive = false;
    private boolean audioFocusHeld = false;
    private String requestedOutputId = "default";
    private final AudioManager.OnAudioFocusChangeListener audioFocusListener =
        focusChange -> {
            if (focusChange == AudioManager.AUDIOFOCUS_GAIN) {
                audioFocusHeld = true;
                Handler handler = mainHandler;
                if (handler != null) {
                    handler.post(() -> {
                        if (!voiceActive) {
                            return;
                        }
                        try {
                            AudioManager manager = manager();
                            manager.setMode(AudioManager.MODE_IN_COMMUNICATION);
                            if (!selectOutput(manager, requestedOutputId)) {
                                requestedOutputId = "default";
                                selectOutput(manager, requestedOutputId);
                            }
                            notifyListeners("devicesChanged", availableDeviceResult());
                        } catch (Exception ignored) {
                            // A later device callback or renderer health pass
                            // will retry without tearing down the call.
                        }
                    });
                }
            } else if (focusChange == AudioManager.AUDIOFOCUS_LOSS) {
                audioFocusHeld = false;
                audioFocusRequest = null;
            }
        };
    private final Runnable refreshRouteAfterDeviceChange =
        () -> {
            try {
                AudioManager manager = manager();
                if (voiceActive) {
                    manager.setMode(AudioManager.MODE_IN_COMMUNICATION);
                    if (!audioFocusHeld) {
                        requestVoiceAudioFocus(manager);
                    }
                    if (!selectOutput(manager, requestedOutputId)) {
                        requestedOutputId = "default";
                        selectOutput(manager, requestedOutputId);
                    }
                }
                notifyListeners("devicesChanged", availableDeviceResult());
            } catch (Exception ignored) {
                // A later manual refresh can recover while Android finishes
                // changing the physical route.
            }
        };

    @Override
    public void load() {
        super.load();
        mainHandler = new Handler(Looper.getMainLooper());
        audioDeviceCallback =
            new AudioDeviceCallback() {
                @Override
                public void onAudioDevicesAdded(AudioDeviceInfo[] addedDevices) {
                    notifyDeviceChange();
                }

                @Override
                public void onAudioDevicesRemoved(AudioDeviceInfo[] removedDevices) {
                    notifyDeviceChange();
                }
            };
        manager().registerAudioDeviceCallback(
            audioDeviceCallback,
            mainHandler
        );
    }

    private AudioManager manager() {
        if (audioManager == null) {
            audioManager =
                (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
        }
        return audioManager;
    }

    @PluginMethod
    public void start(PluginCall call) {
        // Speaker/earpiece voice chat must keep working even when the user
        // declines the optional Nearby devices permission. Bluetooth routing
        // can be requested later when that output is explicitly selected.
        startWithPermission(call);
    }

    @PermissionCallback
    public void startAfterBluetoothPermission(PluginCall call) {
        if (needsBluetoothPermission()) {
            call.reject("需要“附近设备”权限才能自动识别和切换蓝牙耳机");
            return;
        }
        startWithPermission(call);
    }

    @PluginMethod
    public void requestBluetoothPermission(PluginCall call) {
        try {
            if (!needsBluetoothPermission()) {
                call.resolve();
                return;
            }
            requestPermissionForAlias(
                "bluetoothConnect",
                call,
                "bluetoothPermissionResult"
            );
        } catch (Exception error) {
            // A permission helper failure must be reported to JavaScript
            // instead of escaping the CapacitorPlugins thread and terminating
            // the whole Android process.
            call.reject("无法请求“附近设备”权限", error);
        }
    }

    @PermissionCallback
    public void bluetoothPermissionResult(PluginCall call) {
        if (needsBluetoothPermission()) {
            call.reject(
                "未获得“附近设备”权限，仍可使用手机扬声器或有线耳机"
            );
            return;
        }
        call.resolve();
        notifyDeviceChange();
    }

    private void startWithPermission(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            try {
                AudioManager manager = manager();
                if (!voiceActive) {
                    previousMode = manager.getMode();
                }
                try {
                    manager.setMode(AudioManager.MODE_IN_COMMUNICATION);
                } catch (Exception modeError) {
                    // Some OEM builds (Xiaomi MIUI, OPPO ColorOS, etc.) reject
                    // MODE_IN_COMMUNICATION with a SecurityException or
                    // IllegalStateException. Voice chat still works via WebRTC's
                    // built-in audio path, so treat this as a non-fatal warning
                    // and continue without it.
                }
                requestVoiceAudioFocus(manager);
                voiceActive = true;
                if (!selectOutput(manager, requestedOutputId)) {
                    requestedOutputId = "default";
                    selectOutput(manager, requestedOutputId);
                }
                // Some vendor Android 12/13 builds throw while enumerating a
                // connected Bluetooth route before Nearby devices is granted.
                // Entering communication mode itself does not need that
                // optional permission, so never let enumeration block voice.
                call.resolve(availableDeviceResult());
            } catch (Exception error) {
                call.reject("无法启用系统连麦音频模式", error);
            }
        });
    }

    @PluginMethod
    public void listOutputs(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            try {
                call.resolve(availableDeviceResult());
            } catch (Exception error) {
                call.reject("无法读取音频输出设备", error);
            }
        });
    }

    @PluginMethod
    public void setOutput(PluginCall call) {
        String requestedId = call.getString("id", "default");
        try {
            // Built-in routes never need Nearby devices access. Check the
            // route first so the ordinary join path cannot enter Android's
            // optional Bluetooth permission machinery.
            if (
                outputMayRequireBluetoothPermission(requestedId) &&
                needsBluetoothPermission()
            ) {
                requestPermissionForAlias(
                    "bluetoothConnect",
                    call,
                    "setOutputAfterBluetoothPermission"
                );
                return;
            }
            setOutputWithPermission(call);
        } catch (Exception error) {
            // Plugin methods run on Capacitor's dedicated HandlerThread.
            // Uncaught exceptions on that thread are process-fatal.
            call.reject("切换音频输出失败", error);
        }
    }

    @PermissionCallback
    public void setOutputAfterBluetoothPermission(PluginCall call) {
        if (needsBluetoothPermission()) {
            call.reject("需要“附近设备”权限才能切换蓝牙耳机");
            return;
        }
        setOutputWithPermission(call);
    }

    private void setOutputWithPermission(PluginCall call) {
        String requestedId = call.getString("id", "default");
        getActivity().runOnUiThread(() -> {
            try {
                AudioManager manager = manager();
                boolean selected = selectOutput(manager, requestedId);
                if (!selected) {
                    call.reject("所选音频设备当前不可用");
                    return;
                }
                requestedOutputId = requestedId;
                call.resolve(availableDeviceResult());
            } catch (Exception error) {
                call.reject("切换音频输出失败", error);
            }
        });
    }

    @PluginMethod
    public void stop(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            restoreAudioMode();
            call.resolve();
        });
    }

    @Override
    protected void handleOnDestroy() {
        if (mainHandler != null) {
            mainHandler.removeCallbacks(refreshRouteAfterDeviceChange);
        }
        if (audioDeviceCallback != null) {
            try {
                manager().unregisterAudioDeviceCallback(audioDeviceCallback);
            } catch (Exception ignored) {
                // The audio service may already be shutting down.
            }
            audioDeviceCallback = null;
        }
        restoreAudioMode();
        mainHandler = null;
        super.handleOnDestroy();
    }

    private boolean needsBluetoothPermission() {
        // Read Android directly. Capacitor's alias-state helper can
        // dereference missing permission metadata in a minified release
        // plugin; because setOutput is invoked on CapacitorPlugins, that NPE
        // is process-fatal instead of a recoverable bridge rejection.
        return (
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.S &&
            ContextCompat.checkSelfPermission(
                getContext(),
                Manifest.permission.BLUETOOTH_CONNECT
            ) != PackageManager.PERMISSION_GRANTED
        );
    }

    private void notifyDeviceChange() {
        Handler handler = mainHandler;
        if (handler == null) {
            return;
        }
        handler.removeCallbacks(refreshRouteAfterDeviceChange);
        // Android can emit the callback before its communication-device list
        // is stable. A short debounce avoids selecting a route that vanishes
        // one callback later.
        handler.postDelayed(refreshRouteAfterDeviceChange, 180);
    }

    private JSObject builtInDeviceResult() {
        JSArray devices = new JSArray();
        devices.put(legacyDevice("speaker", "手机扬声器", "speaker"));
        devices.put(legacyDevice("earpiece", "手机听筒", "earpiece"));
        JSObject result = new JSObject();
        result.put("devices", devices);
        result.put(
            "selectedId",
            "speaker".equals(requestedOutputId) ||
                "earpiece".equals(requestedOutputId)
                ? requestedOutputId
                : "default"
        );
        return result;
    }

    private JSObject availableDeviceResult() {
        try {
            return deviceResult(!needsBluetoothPermission());
        } catch (SecurityException ignored) {
            return builtInDeviceResult();
        }
    }

    private boolean outputMayRequireBluetoothPermission(String requestedId) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
            return false;
        }
        if (
            "default".equals(requestedId) ||
            "speaker".equals(requestedId) ||
            "earpiece".equals(requestedId)
        ) {
            return false;
        }
        try {
            for (AudioDeviceInfo device :
                manager().getAvailableCommunicationDevices()) {
                if (deviceId(device).equals(requestedId)) {
                    return "bluetooth".equals(deviceKind(device.getType()));
                }
            }
        } catch (SecurityException ignored) {
            // Android can hide Bluetooth endpoints until Nearby devices is
            // granted. Unknown IDs therefore remain permission-gated.
        }
        return true;
    }

    private void restoreAudioMode() {
        AudioManager manager = manager();
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                manager.clearCommunicationDevice();
            } else {
                manager.setSpeakerphoneOn(false);
            }
            if (voiceActive) {
                manager.setMode(previousMode);
            }
        } catch (Exception ignored) {
            // Android may already be tearing the audio service down.
        } finally {
            try {
                abandonVoiceAudioFocus(manager);
            } catch (Exception ignored) {
                // Audio focus can already be gone during process teardown.
            }
        }
        voiceActive = false;
        requestedOutputId = "default";
    }

    private void requestVoiceAudioFocus(AudioManager manager) {
        if (audioFocusHeld) {
            return;
        }
        AudioAttributes attributes =
            new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                .build();
        audioFocusRequest =
            new AudioFocusRequest.Builder(
                AudioManager.AUDIOFOCUS_GAIN_TRANSIENT
            )
                .setAudioAttributes(attributes)
                .setAcceptsDelayedFocusGain(false)
                .setWillPauseWhenDucked(false)
                .setOnAudioFocusChangeListener(
                    audioFocusListener,
                    mainHandler
                )
                .build();
        int result = manager.requestAudioFocus(audioFocusRequest);
        audioFocusHeld = result == AudioManager.AUDIOFOCUS_REQUEST_GRANTED;
    }

    private void abandonVoiceAudioFocus(AudioManager manager) {
        if (audioFocusRequest != null) {
            manager.abandonAudioFocusRequest(audioFocusRequest);
            audioFocusRequest = null;
        }
        audioFocusHeld = false;
    }

    private boolean selectOutput(
        AudioManager manager,
        String requestedId
    ) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            if ("default".equals(requestedId)) {
                return selectAutomaticOutput(manager);
            }
            boolean builtIn =
                "speaker".equals(requestedId) ||
                "earpiece".equals(requestedId);
            try {
                for (AudioDeviceInfo device :
                    manager.getAvailableCommunicationDevices()) {
                    if (
                        (
                            deviceId(device).equals(requestedId) ||
                            (
                                builtIn &&
                                deviceKind(device.getType()).equals(requestedId)
                            )
                        ) &&
                        manager.setCommunicationDevice(device)
                    ) {
                        return true;
                    }
                }
            } catch (SecurityException ignored) {
                // Built-in routes remain selectable without Nearby devices.
            }
            if (builtIn) {
                manager.clearCommunicationDevice();
                manager.setSpeakerphoneOn("speaker".equals(requestedId));
                return true;
            }
            return false;
        }
        if ("speaker".equals(requestedId)) {
            manager.setSpeakerphoneOn(true);
            return true;
        }
        if ("earpiece".equals(requestedId)) {
            manager.setSpeakerphoneOn(false);
            return true;
        }
        if ("default".equals(requestedId)) {
            // A watch-party should remain audible when voice chat changes
            // Android into communication mode.
            manager.setSpeakerphoneOn(true);
            return true;
        }
        return false;
    }

    private JSObject deviceResult(boolean includeBluetooth) {
        AudioManager manager = manager();
        JSArray devices = new JSArray();
        String selectedId = "default";
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            AudioDeviceInfo selected = manager.getCommunicationDevice();
            if (selected != null) {
                selectedId = deviceId(selected);
            }
            List<AudioDeviceInfo> available =
                manager.getAvailableCommunicationDevices();
            boolean hasSpeaker = false;
            boolean hasEarpiece = false;
            for (AudioDeviceInfo device : available) {
                String kind = deviceKind(device.getType());
                if (!includeBluetooth && "bluetooth".equals(kind)) {
                    continue;
                }
                hasSpeaker = hasSpeaker || "speaker".equals(kind);
                hasEarpiece = hasEarpiece || "earpiece".equals(kind);
                devices.put(deviceJson(device));
            }
            if (!hasSpeaker) {
                devices.put(
                    legacyDevice("speaker", "手机扬声器", "speaker")
                );
            }
            if (!hasEarpiece) {
                devices.put(
                    legacyDevice("earpiece", "手机听筒", "earpiece")
                );
            }
        } else {
            devices.put(legacyDevice("earpiece", "手机听筒", "earpiece"));
            devices.put(legacyDevice("speaker", "手机扬声器", "speaker"));
            selectedId = manager.isSpeakerphoneOn() ? "speaker" : "earpiece";
        }
        JSObject result = new JSObject();
        result.put("devices", devices);
        result.put("selectedId", selectedId);
        return result;
    }

    @RequiresApi(Build.VERSION_CODES.S)
    private boolean selectAutomaticOutput(AudioManager manager) {
        AudioDeviceInfo speaker = null;
        AudioDeviceInfo earpiece = null;
        try {
            for (AudioDeviceInfo device : manager.getAvailableCommunicationDevices()) {
                String kind = deviceKind(device.getType());
                if (
                    (
                        "bluetooth".equals(kind) ||
                        "wired".equals(kind) ||
                        "usb".equals(kind)
                    ) &&
                    manager.setCommunicationDevice(device)
                ) {
                    return true;
                }
                if ("speaker".equals(kind)) {
                    speaker = device;
                } else if ("earpiece".equals(kind)) {
                    earpiece = device;
                }
            }
            if (
                speaker != null &&
                manager.setCommunicationDevice(speaker)
            ) {
                return true;
            }
            if (
                earpiece != null &&
                manager.setCommunicationDevice(earpiece)
            ) {
                return true;
            }
        } catch (SecurityException ignored) {
            // Nearby devices was declined. Built-in speaker routing below
            // remains available and is preferable to rejecting voice chat.
        }
        manager.clearCommunicationDevice();
        manager.setSpeakerphoneOn(true);
        return true;
    }

    private JSObject deviceJson(AudioDeviceInfo device) {
        JSObject item = new JSObject();
        item.put("id", deviceId(device));
        item.put("label", deviceLabel(device));
        item.put("kind", deviceKind(device.getType()));
        return item;
    }

    private JSObject legacyDevice(String id, String label, String kind) {
        JSObject item = new JSObject();
        item.put("id", id);
        item.put("label", label);
        item.put("kind", kind);
        return item;
    }

    private String deviceId(AudioDeviceInfo device) {
        String kind = deviceKind(device.getType());
        if ("speaker".equals(kind) || "earpiece".equals(kind)) {
            return kind;
        }
        return "android:" + device.getId();
    }

    private String deviceLabel(AudioDeviceInfo device) {
        String product = String.valueOf(device.getProductName()).trim();
        String kind = deviceKind(device.getType());
        String fallback;
        switch (kind) {
            case "speaker":
                fallback = "手机扬声器";
                break;
            case "earpiece":
                fallback = "手机听筒";
                break;
            case "bluetooth":
                fallback = "蓝牙耳机";
                break;
            case "wired":
                fallback = "有线耳机";
                break;
            case "usb":
                fallback = "USB 音频设备";
                break;
            default:
                fallback = "系统音频设备";
        }
        if (product.isEmpty() || "null".equalsIgnoreCase(product)) {
            return fallback;
        }
        return fallback + " · " + product;
    }

    private String deviceKind(int type) {
        switch (type) {
            case AudioDeviceInfo.TYPE_BUILTIN_SPEAKER:
            case AudioDeviceInfo.TYPE_BUILTIN_SPEAKER_SAFE:
                return "speaker";
            case AudioDeviceInfo.TYPE_BUILTIN_EARPIECE:
                return "earpiece";
            case AudioDeviceInfo.TYPE_WIRED_HEADSET:
            case AudioDeviceInfo.TYPE_WIRED_HEADPHONES:
                return "wired";
            case AudioDeviceInfo.TYPE_BLUETOOTH_A2DP:
            case AudioDeviceInfo.TYPE_BLUETOOTH_SCO:
            case AudioDeviceInfo.TYPE_HEARING_AID:
                return "bluetooth";
            case AudioDeviceInfo.TYPE_USB_ACCESSORY:
            case AudioDeviceInfo.TYPE_USB_DEVICE:
            case AudioDeviceInfo.TYPE_USB_HEADSET:
                return "usb";
            default:
                if (
                    Build.VERSION.SDK_INT >= Build.VERSION_CODES.S &&
                    (
                        type == AudioDeviceInfo.TYPE_BLE_HEADSET ||
                        type == AudioDeviceInfo.TYPE_BLE_SPEAKER
                    )
                ) {
                    return "bluetooth";
                }
                return "other";
        }
    }
}
