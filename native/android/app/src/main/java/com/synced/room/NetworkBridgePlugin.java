package com.synced.room;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.LinkAddress;
import android.net.LinkProperties;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.util.Log;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

@CapacitorPlugin(name = "NetworkBridge")
public class NetworkBridgePlugin extends Plugin {
    private static final String PLAYBACK_LOG_TAG = "SyncedPlayback";
    private ConnectivityManager manager;
    private ConnectivityManager.NetworkCallback networkCallback;
    private String lastNetworkSignature = "";

    @PluginMethod
    public void reportDiagnostic(PluginCall call) {
        String event = call.getString("event", "playback");
        String detail = call.getString("detail", "{}");
        if (event.length() > 80) event = event.substring(0, 80);
        if (detail.length() > 2400) detail = detail.substring(0, 2400);
        Log.i(PLAYBACK_LOG_TAG, event + " " + detail);
        call.resolve();
    }

    @Override
    public void load() {
        manager =
            (ConnectivityManager) getContext().getSystemService(
                Context.CONNECTIVITY_SERVICE
            );
        lastNetworkSignature = buildNetworkSignature();
        networkCallback =
            new ConnectivityManager.NetworkCallback() {
                @Override
                public void onAvailable(Network network) {
                    emitNetworkChanged();
                }

                @Override
                public void onLost(Network network) {
                    emitNetworkChanged();
                }

                @Override
                public void onCapabilitiesChanged(
                    Network network,
                    NetworkCapabilities capabilities
                ) {
                    emitNetworkChanged();
                }

                @Override
                public void onLinkPropertiesChanged(
                    Network network,
                    LinkProperties properties
                ) {
                    emitNetworkChanged();
                }
            };
        manager.registerDefaultNetworkCallback(networkCallback);
    }

    private synchronized void emitNetworkChanged() {
        String signature = buildNetworkSignature();
        if (signature.equals(lastNetworkSignature)) return;
        lastNetworkSignature = signature;
        JSObject result = new JSObject();
        result.put("connected", !"offline".equals(signature));
        result.put("signature", signature);
        notifyListeners("networkChanged", result, true);
    }

    /**
     * Android reports capability changes for ordinary Wi-Fi RSSI, validation
     * and metering updates. None of those changes invalidate a WebRTC route.
     * Only network identity, physical transport, interface or IPv4 changes are
     * included here, so a harmless callback can never restart movie playback.
     */
    private String buildNetworkSignature() {
        if (manager == null) return "offline";
        Network active = bestPhysicalNetwork();
        if (active == null) return "offline";
        LinkProperties properties = manager.getLinkProperties(active);
        NetworkCapabilities capabilities =
            manager.getNetworkCapabilities(active);
        List<String> addresses = new ArrayList<>();
        if (properties != null) {
            for (LinkAddress linkAddress : properties.getLinkAddresses()) {
                InetAddress address = linkAddress.getAddress();
                if (
                    address instanceof Inet4Address &&
                    !address.isAnyLocalAddress() &&
                    !address.isLoopbackAddress() &&
                    !address.isLinkLocalAddress()
                ) {
                    addresses.add(address.getHostAddress());
                }
            }
        }
        Collections.sort(addresses);
        String transport = "other";
        if (capabilities != null) {
            if (
                capabilities.hasTransport(
                    NetworkCapabilities.TRANSPORT_ETHERNET
                )
            ) {
                transport = "ethernet";
            } else if (
                capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)
            ) {
                transport = "wifi";
            } else if (
                capabilities.hasTransport(
                    NetworkCapabilities.TRANSPORT_CELLULAR
                )
            ) {
                transport = "cellular";
            } else if (
                capabilities.hasTransport(NetworkCapabilities.TRANSPORT_VPN)
            ) {
                transport = "vpn";
            }
        }
        String interfaceName =
            properties == null || properties.getInterfaceName() == null
                ? ""
                : properties.getInterfaceName();
        return (
            active.toString() +
            "|" +
            transport +
            "|" +
            interfaceName +
            "|" +
            String.join(",", addresses)
        );
    }

    /**
     * Use the same physical route as MainActivity instead of Android's
     * default network, which is often a VPN/TUN interface. Otherwise a proxy
     * refresh changes the VPN capabilities and looks like a real route
     * switch even though the WebRTC path never changed.
     */
    private Network bestPhysicalNetwork() {
        if (manager == null) return null;
        Network active = manager.getActiveNetwork();
        NetworkCapabilities activeCapabilities =
            active == null ? null : manager.getNetworkCapabilities(active);
        if (isUsablePhysical(activeCapabilities)) return active;

        Network validatedCellular = null;
        Network fallback = null;
        for (Network network : manager.getAllNetworks()) {
            NetworkCapabilities capabilities =
                manager.getNetworkCapabilities(network);
            if (!isUsablePhysical(capabilities)) continue;
            if (fallback == null) fallback = network;
            boolean validated = capabilities.hasCapability(
                NetworkCapabilities.NET_CAPABILITY_VALIDATED
            );
            if (
                validated &&
                (
                    capabilities.hasTransport(
                        NetworkCapabilities.TRANSPORT_WIFI
                    ) ||
                    capabilities.hasTransport(
                        NetworkCapabilities.TRANSPORT_ETHERNET
                    )
                )
            ) {
                return network;
            }
            if (
                validatedCellular == null &&
                validated &&
                capabilities.hasTransport(
                    NetworkCapabilities.TRANSPORT_CELLULAR
                )
            ) {
                validatedCellular = network;
            }
        }
        return validatedCellular != null ? validatedCellular : fallback;
    }

    private boolean isUsablePhysical(NetworkCapabilities capabilities) {
        return (
            capabilities != null &&
            capabilities.hasCapability(
                NetworkCapabilities.NET_CAPABILITY_INTERNET
            ) &&
            !capabilities.hasTransport(NetworkCapabilities.TRANSPORT_VPN)
        );
    }

    @Override
    protected void handleOnDestroy() {
        if (manager != null && networkCallback != null) {
            try {
                manager.unregisterNetworkCallback(networkCallback);
            } catch (Exception ignored) {
                // The system may already have removed the callback.
            }
        }
        networkCallback = null;
        manager = null;
    }

    @PluginMethod
    public void getLocalAddresses(PluginCall call) {
        try {
            Set<String> addresses = new LinkedHashSet<>();
            ConnectivityManager manager = this.manager != null
                ? this.manager
                : (ConnectivityManager) getContext().getSystemService(
                    Context.CONNECTIVITY_SERVICE
                );
            Network active = bestPhysicalNetwork();
            LinkProperties properties =
                active == null ? null : manager.getLinkProperties(active);
            if (properties != null && !isVirtualInterface(properties.getInterfaceName())) {
                for (LinkAddress linkAddress : properties.getLinkAddresses()) {
                    addAddress(addresses, linkAddress.getAddress());
                }
            }

            if (addresses.isEmpty()) {
                for (
                    NetworkInterface networkInterface :
                    Collections.list(NetworkInterface.getNetworkInterfaces())
                ) {
                    if (
                        !networkInterface.isUp() ||
                        networkInterface.isLoopback() ||
                        isVirtualInterface(networkInterface.getName())
                    ) {
                        continue;
                    }
                    for (
                        InetAddress address :
                        Collections.list(networkInterface.getInetAddresses())
                    ) {
                        addAddress(addresses, address);
                    }
                }
            }

            JSArray values = new JSArray();
            for (String address : addresses) {
                values.put(address);
            }
            JSObject result = new JSObject();
            result.put("addresses", values);
            result.put("signature", buildNetworkSignature());
            call.resolve(result);
        } catch (Exception error) {
            call.reject("无法读取当前网络地址", error);
        }
    }

    private void addAddress(Set<String> addresses, InetAddress address) {
        if (
            !(address instanceof Inet4Address) ||
            address.isAnyLocalAddress() ||
            address.isLoopbackAddress() ||
            address.isLinkLocalAddress() ||
            address.isMulticastAddress()
        ) {
            return;
        }
        String value = address.getHostAddress();
        if (
            value == null ||
            value.startsWith("169.254.") ||
            value.startsWith("198.18.") ||
            value.startsWith("198.19.")
        ) {
            return;
        }
        addresses.add(value);
    }

    private boolean isVirtualInterface(String name) {
        if (name == null) return false;
        String normalized = name.toLowerCase(Locale.ROOT);
        return (
            normalized.startsWith("tun") ||
            normalized.startsWith("tap") ||
            normalized.startsWith("ppp") ||
            normalized.startsWith("wg") ||
            normalized.contains("vpn") ||
            normalized.contains("clash") ||
            normalized.contains("mihomo") ||
            normalized.contains("wireguard") ||
            normalized.contains("openvpn") ||
            normalized.contains("sing-box") ||
            normalized.contains("v2ray") ||
            normalized.contains("xray") ||
            normalized.contains("tailscale") ||
            normalized.contains("zerotier")
        );
    }
}
