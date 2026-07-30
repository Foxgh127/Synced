package com.synced.room;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "NativeClipboard")
public class NativeClipboardPlugin extends Plugin {
    private ClipboardManager clipboard() {
        return (ClipboardManager) getContext()
            .getSystemService(Context.CLIPBOARD_SERVICE);
    }

    @PluginMethod
    public void write(PluginCall call) {
        String text = call.getString("text");
        if (text == null || text.isEmpty()) {
            call.reject("没有可复制的内容");
            return;
        }
        ClipboardManager manager = clipboard();
        if (manager == null) {
            call.reject("手机剪贴板不可用");
            return;
        }
        manager.setPrimaryClip(ClipData.newPlainText("同频频道邀请", text));
        JSObject result = new JSObject();
        result.put("ok", true);
        call.resolve(result);
    }

}
