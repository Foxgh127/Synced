package com.synced.room;

import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.BatteryManager;
import android.os.Build;
import android.os.PowerManager;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "DeviceResource")
public class DeviceResourcePlugin extends Plugin {
    @PluginMethod
    public void getState(PluginCall call) {
        try {
            BatteryManager batteryManager =
                (BatteryManager) getContext().getSystemService(
                    Context.BATTERY_SERVICE
                );
            PowerManager powerManager =
                (PowerManager) getContext().getSystemService(
                    Context.POWER_SERVICE
                );
            Intent battery = getContext().registerReceiver(
                null,
                new IntentFilter(Intent.ACTION_BATTERY_CHANGED)
            );

            int level = battery == null
                ? -1
                : battery.getIntExtra(BatteryManager.EXTRA_LEVEL, -1);
            int scale = battery == null
                ? -1
                : battery.getIntExtra(BatteryManager.EXTRA_SCALE, -1);
            double batteryLevel = -1.0;
            if (level >= 0 && scale > 0) {
                batteryLevel = Math.max(
                    0.0,
                    Math.min(1.0, level / (double) scale)
                );
            } else if (batteryManager != null) {
                int capacity = batteryManager.getIntProperty(
                    BatteryManager.BATTERY_PROPERTY_CAPACITY
                );
                if (capacity >= 0) {
                    batteryLevel = Math.max(
                        0.0,
                        Math.min(1.0, capacity / 100.0)
                    );
                }
            }
            int status = battery == null
                ? BatteryManager.BATTERY_STATUS_UNKNOWN
                : battery.getIntExtra(
                    BatteryManager.EXTRA_STATUS,
                    BatteryManager.BATTERY_STATUS_UNKNOWN
                );
            int plugged = battery == null
                ? 0
                : battery.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0);
            boolean charging =
                status == BatteryManager.BATTERY_STATUS_CHARGING ||
                status == BatteryManager.BATTERY_STATUS_FULL ||
                plugged != 0;
            int thermalStatus =
                powerManager != null &&
                    Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
                    ? powerManager.getCurrentThermalStatus()
                    : -1;

            JSObject result = new JSObject();
            if (batteryLevel >= 0) {
                result.put("batteryLevel", batteryLevel);
            }
            result.put("charging", charging);
            result.put(
                "powerSaveMode",
                powerManager != null && powerManager.isPowerSaveMode()
            );
            result.put(
                "deviceIdleMode",
                powerManager != null &&
                    Build.VERSION.SDK_INT >= Build.VERSION_CODES.M &&
                    powerManager.isDeviceIdleMode()
            );
            result.put("thermalStatus", thermalStatus);
            result.put("thermalState", thermalState(thermalStatus));
            result.put(
                "interactive",
                powerManager == null || powerManager.isInteractive()
            );
            call.resolve(result);
        } catch (Exception error) {
            call.reject("无法读取设备功耗与温度状态", error);
        }
    }

    private String thermalState(int status) {
        switch (status) {
            case PowerManager.THERMAL_STATUS_NONE:
                return "none";
            case PowerManager.THERMAL_STATUS_LIGHT:
                return "light";
            case PowerManager.THERMAL_STATUS_MODERATE:
                return "moderate";
            case PowerManager.THERMAL_STATUS_SEVERE:
                return "severe";
            case PowerManager.THERMAL_STATUS_CRITICAL:
                return "critical";
            case PowerManager.THERMAL_STATUS_EMERGENCY:
                return "emergency";
            case PowerManager.THERMAL_STATUS_SHUTDOWN:
                return "shutdown";
            default:
                return "unknown";
        }
    }
}
