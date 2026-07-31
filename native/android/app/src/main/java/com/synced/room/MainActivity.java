package com.synced.room;

import android.os.Bundle;
import android.content.pm.ApplicationInfo;
import android.media.AudioManager;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(ImmersiveModePlugin.class);
        registerPlugin(AudioRoutePlugin.class);
        registerPlugin(NetworkBridgePlugin.class);
        registerPlugin(NativeClipboardPlugin.class);
        registerPlugin(PlaybackControlsPlugin.class);
        registerPlugin(DeviceResourcePlugin.class);
        registerPlugin(SecureCredentialsPlugin.class);
        // Keep WebSocket and TURN traffic on Android's selected default
        // network. Binding the whole process to Wi-Fi bypassed global VPNs
        // and black-holed the app when "block connections without VPN" was
        // enabled. NetworkBridge still reports the physical LAN address for
        // direct media candidate filtering without rerouting the process.
        super.onCreate(savedInstanceState);
        setVolumeControlStream(AudioManager.STREAM_MUSIC);
        bridge.getWebView().getSettings().setMediaPlaybackRequiresUserGesture(false);
        bridge
            .getWebView()
            .setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_BOUND, true);
        WebView.setWebContentsDebuggingEnabled(
            (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0
        );
    }

}
