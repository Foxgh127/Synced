package com.synced.room;

import android.Manifest;
import android.content.Intent;
import android.os.Build;
import android.provider.Settings;
import android.view.WindowManager;

import com.getcapacitor.PermissionState;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

@CapacitorPlugin(
    name = "PlaybackControls",
    permissions = {
        @Permission(
            alias = "notifications",
            strings = { Manifest.permission.POST_NOTIFICATIONS }
        )
    }
)
public class PlaybackControlsPlugin extends Plugin {
    @PluginMethod
    public void getState(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            try {
                call.resolve(currentState());
            } catch (Exception error) {
                call.reject("无法读取播放控制状态", error);
            }
        });
    }

    @PluginMethod
    public void setBrightness(PluginCall call) {
        double requested = call.getDouble("value", 0.5);
        float brightness = (float) Math.max(0.02, Math.min(1.0, requested));
        getActivity().runOnUiThread(() -> {
            try {
                WindowManager.LayoutParams attributes =
                    getActivity().getWindow().getAttributes();
                attributes.screenBrightness = brightness;
                getActivity().getWindow().setAttributes(attributes);
                call.resolve(currentState());
            } catch (Exception error) {
                call.reject("调节亮度失败", error);
            }
        });
    }

    @PluginMethod
    public void setPlaybackActive(PluginCall call) {
        boolean active = Boolean.TRUE.equals(call.getBoolean("active", false));
        if (
            active &&
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            getPermissionState("notifications") != PermissionState.GRANTED
        ) {
            requestPermissionForAlias(
                "notifications",
                call,
                "notificationPermissionCallback"
            );
            return;
        }
        applyPlaybackActive(call);
    }

    @PermissionCallback
    private void notificationPermissionCallback(PluginCall call) {
        if (
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            getPermissionState("notifications") != PermissionState.GRANTED
        ) {
            call.reject(
                "需要通知权限才能在后台保持播放；请在系统设置中允许“同频”通知"
            );
            return;
        }
        applyPlaybackActive(call);
    }

    private void applyPlaybackActive(PluginCall call) {
        boolean active = Boolean.TRUE.equals(call.getBoolean("active", false));
        String title = call.getString("title", "正在观看频道");
        getActivity().runOnUiThread(() -> {
            try {
                if (active) {
                    getActivity()
                        .getWindow()
                        .addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                    Intent service = new Intent(
                        getContext(),
                        PlaybackForegroundService.class
                    );
                    service.putExtra(PlaybackForegroundService.EXTRA_TITLE, title);
                    getContext().startForegroundService(service);
                } else {
                    getActivity()
                        .getWindow()
                        .clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                    getContext().stopService(
                        new Intent(
                            getContext(),
                            PlaybackForegroundService.class
                        )
                    );
                }
                JSObject result = new JSObject();
                result.put("active", active);
                call.resolve(result);
            } catch (Exception error) {
                call.reject(
                    active
                        ? "无法启动后台播放保护"
                        : "无法停止后台播放保护",
                    error
                );
            }
        });
    }

    private JSObject currentState() {
        float windowBrightness =
            getActivity().getWindow().getAttributes().screenBrightness;
        double brightness = windowBrightness;
        if (windowBrightness < 0) {
            try {
                int systemBrightness = Settings.System.getInt(
                    getContext().getContentResolver(),
                    Settings.System.SCREEN_BRIGHTNESS
                );
                brightness = systemBrightness / 255.0;
            } catch (Settings.SettingNotFoundException ignored) {
                brightness = 0.5;
            }
        }
        JSObject result = new JSObject();
        result.put("brightness", Math.max(0.02, Math.min(1.0, brightness)));
        // Volume is owned by the renderer's media elements. Returning a
        // neutral value keeps this bridge from coupling gestures to the
        // process-wide STREAM_MUSIC state.
        result.put("volume", 1.0);
        return result;
    }
}
