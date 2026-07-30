package com.yiqikan.room;

import android.content.Context;
import android.content.Intent;
import android.media.AudioManager;
import android.provider.Settings;
import android.view.WindowManager;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "PlaybackControls")
public class PlaybackControlsPlugin extends Plugin {
    private AudioManager audioManager;

    private AudioManager manager() {
        if (audioManager == null) {
            audioManager =
                (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
        }
        return audioManager;
    }

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
    public void setVolume(PluginCall call) {
        double requested = call.getDouble("value", 0.5);
        getActivity().runOnUiThread(() -> {
            try {
                AudioManager manager = manager();
                int maximum = Math.max(
                    1,
                    manager.getStreamMaxVolume(AudioManager.STREAM_MUSIC)
                );
                int volume = (int) Math.round(
                    Math.max(0.0, Math.min(1.0, requested)) * maximum
                );
                manager.setStreamVolume(
                    AudioManager.STREAM_MUSIC,
                    volume,
                    0
                );
                call.resolve(currentState());
            } catch (Exception error) {
                call.reject("调节音量失败", error);
            }
        });
    }

    @PluginMethod
    public void setPlaybackActive(PluginCall call) {
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
        AudioManager manager = manager();
        int maximum = Math.max(
            1,
            manager.getStreamMaxVolume(AudioManager.STREAM_MUSIC)
        );
        int volume = manager.getStreamVolume(AudioManager.STREAM_MUSIC);
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
        result.put("volume", Math.max(0.0, Math.min(1.0, volume / (double) maximum)));
        return result;
    }
}
