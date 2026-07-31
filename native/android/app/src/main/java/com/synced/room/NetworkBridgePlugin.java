package com.synced.room;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.LinkAddress;
import android.net.LinkProperties;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
import android.util.Log;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.net.Inet4Address;
import java.net.Inet6Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

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
        NetworkRequest request = new NetworkRequest.Builder()
            .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .build();
        manager.registerNetworkCallback(request, networkCallback);
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
     * The app does not bind its process or sockets to a physical interface.
     * WebView, WebRTC and HTTPS therefore follow Android's default-routed
     * network, including an always-on VPN. The signature includes both that
     * routed path and the best physical underlay so either real change can
     * trigger media recovery.
     */
    private String buildNetworkSignature() {
        if (manager == null || manager.getActiveNetwork() == null) {
            return "offline";
        }
        Network defaultNetwork = manager.getActiveNetwork();
        Network physicalNetwork = bestPhysicalNetwork();
        return (
            networkSignature(defaultNetwork) +
            "|physical=" +
            networkSignature(physicalNetwork) +
            "|vpn=" +
            vpnActive()
        );
    }

    private String networkSignature(Network network) {
        if (network == null) return "none";
        LinkProperties properties = manager.getLinkProperties(network);
        NetworkCapabilities capabilities =
            manager.getNetworkCapabilities(network);
        List<String> addresses = addressStrings(properties);
        return (
            network.toString() +
            ":" +
            primaryTransport(capabilities) +
            ":" +
            (
                properties == null || properties.getInterfaceName() == null
                    ? ""
                    : properties.getInterfaceName()
            ) +
            ":" +
            String.join(",", addresses)
        );
    }

    private Network bestPhysicalNetwork() {
        if (manager == null) return null;
        Network active = manager.getActiveNetwork();
        NetworkCapabilities activeCapabilities =
            active == null ? null : manager.getNetworkCapabilities(active);
        if (isUsablePhysical(activeCapabilities)) return active;

        List<Network> candidates = new ArrayList<>();
        Collections.addAll(candidates, manager.getAllNetworks());
        candidates.sort(
            Comparator.comparingInt(network ->
                physicalNetworkRank(manager.getNetworkCapabilities(network))
            )
        );
        for (Network network : candidates) {
            if (isUsablePhysical(manager.getNetworkCapabilities(network))) {
                return network;
            }
        }
        return null;
    }

    private int physicalNetworkRank(NetworkCapabilities capabilities) {
        if (capabilities == null) return 100;
        int rank = capabilities.hasCapability(
            NetworkCapabilities.NET_CAPABILITY_VALIDATED
        )
            ? 0
            : 10;
        if (capabilities.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)) {
            return rank;
        }
        if (capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) {
            return rank + 1;
        }
        if (capabilities.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)) {
            return rank + 2;
        }
        return rank + 5;
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

    private boolean vpnActive() {
        if (manager == null) return false;
        for (Network network : manager.getAllNetworks()) {
            NetworkCapabilities capabilities =
                manager.getNetworkCapabilities(network);
            if (
                capabilities != null &&
                capabilities.hasTransport(NetworkCapabilities.TRANSPORT_VPN)
            ) {
                return true;
            }
        }
        return false;
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
            ConnectivityManager connectivity = this.manager != null
                ? this.manager
                : (ConnectivityManager) getContext().getSystemService(
                    Context.CONNECTIVITY_SERVICE
                );
            this.manager = connectivity;
            Network defaultNetwork = connectivity.getActiveNetwork();
            Network physicalNetwork = bestPhysicalNetwork();
            Network boundNetwork = connectivity.getBoundNetworkForProcess();
            Network socketNetwork =
                boundNetwork == null ? defaultNetwork : boundNetwork;

            Map<String, JSObject> addressRecords = new LinkedHashMap<>();
            for (Network network : connectivity.getAllNetworks()) {
                addNetworkAddresses(
                    addressRecords,
                    network,
                    network.equals(defaultNetwork),
                    network.equals(physicalNetwork)
                );
            }
            addUnmappedInterfaceAddresses(addressRecords);

            List<String> directHints = new ArrayList<>();
            for (JSObject record : addressRecords.values()) {
                if (record.optBoolean("directHintEligible", false)) {
                    directHints.add(record.optString("address", ""));
                }
            }
            directHints.removeIf(String::isEmpty);
            Collections.sort(directHints);

            JSArray values = new JSArray();
            for (String address : directHints) values.put(address);
            JSArray allAddresses = new JSArray();
            for (JSObject record : addressRecords.values()) {
                allAddresses.put(record);
            }

            JSObject socketPath = new JSObject();
            socketPath.put(
                "selection",
                boundNetwork == null ? "system-default" : "process-bound"
            );
            socketPath.put("processBound", boundNetwork != null);
            // Android does not expose the selected route of arbitrary
            // WebView/WebRTC sockets here. This is the routing basis, not a
            // fabricated per-socket observation; selected ICE-pair telemetry
            // is reported separately by the renderer.
            socketPath.put("observed", false);
            socketPath.put(
                "basis",
                boundNetwork == null
                    ? "system-default-route"
                    : "process-network-binding"
            );
            socketPath.put(
                "network",
                describeNetwork(socketNetwork, "socket-selected")
            );

            JSObject result = new JSObject();
            result.put("addresses", values);
            result.put("allAddresses", allAddresses);
            result.put(
                "physicalNetwork",
                describeNetwork(physicalNetwork, "physical")
            );
            result.put(
                "defaultRoutedNetwork",
                describeNetwork(defaultNetwork, "default-routed")
            );
            result.put("vpnActive", vpnActive());
            result.put("socketSelectedPath", socketPath);
            result.put("signature", buildNetworkSignature());
            call.resolve(result);
        } catch (Exception error) {
            call.reject("无法读取当前网络地址与路由", error);
        }
    }

    private void addNetworkAddresses(
        Map<String, JSObject> records,
        Network network,
        boolean isDefault,
        boolean isPhysical
    ) {
        LinkProperties properties = manager.getLinkProperties(network);
        NetworkCapabilities capabilities =
            manager.getNetworkCapabilities(network);
        if (properties == null) return;
        String interfaceName = properties.getInterfaceName();
        boolean tunnel =
            (
                capabilities != null &&
                capabilities.hasTransport(NetworkCapabilities.TRANSPORT_VPN)
            ) ||
            isVirtualInterface(interfaceName);
        for (LinkAddress linkAddress : properties.getLinkAddresses()) {
            addAddressRecord(
                records,
                linkAddress.getAddress(),
                interfaceName,
                network.toString(),
                isDefault,
                isPhysical,
                tunnel
            );
        }
    }

    private void addUnmappedInterfaceAddresses(
        Map<String, JSObject> records
    ) throws Exception {
        for (
            NetworkInterface networkInterface :
            Collections.list(NetworkInterface.getNetworkInterfaces())
        ) {
            if (!networkInterface.isUp() || networkInterface.isLoopback()) {
                continue;
            }
            for (
                InetAddress address :
                Collections.list(networkInterface.getInetAddresses())
            ) {
                addAddressRecord(
                    records,
                    address,
                    networkInterface.getName(),
                    "",
                    false,
                    false,
                    isVirtualInterface(networkInterface.getName())
                );
            }
        }
    }

    private void addAddressRecord(
        Map<String, JSObject> records,
        InetAddress address,
        String interfaceName,
        String networkId,
        boolean isDefault,
        boolean isPhysical,
        boolean tunnel
    ) {
        if (
            address == null ||
            address.isAnyLocalAddress() ||
            address.isLoopbackAddress() ||
            address.isLinkLocalAddress() ||
            address.isMulticastAddress()
        ) {
            return;
        }
        String value = normalizedAddress(address);
        if (value.isEmpty()) return;
        String key = (interfaceName == null ? "" : interfaceName) + "|" + value;
        boolean privateAddress = isPrivateAddress(address, value);
        JSObject record = new JSObject();
        record.put("address", value);
        record.put(
            "family",
            address instanceof Inet6Address ? "ipv6" : "ipv4"
        );
        record.put("interfaceName", interfaceName == null ? "" : interfaceName);
        record.put("networkId", networkId);
        record.put("defaultRouted", isDefault);
        record.put("physical", isPhysical);
        record.put("tunnel", tunnel);
        record.put("private", privateAddress);
        record.put("privacySensitive", !privateAddress);
        record.put("directHintEligible", true);
        // Overlay networks are not discarded: their RFC1918, CGNAT or ULA
        // address may be the room's best direct route. Globally routable host
        // addresses remain visible to diagnostics but require a future,
        // explicit disclosure grant before being advertised as a direct hint.
        record.put("publishable", privateAddress);
        records.put(key, record);
    }

    private JSObject describeNetwork(Network network, String role) {
        if (network == null || manager == null) return null;
        LinkProperties properties = manager.getLinkProperties(network);
        NetworkCapabilities capabilities =
            manager.getNetworkCapabilities(network);
        JSObject result = new JSObject();
        result.put("id", network.toString());
        result.put("role", role);
        result.put("transport", primaryTransport(capabilities));
        result.put(
            "interfaceName",
            properties == null || properties.getInterfaceName() == null
                ? ""
                : properties.getInterfaceName()
        );
        result.put(
            "vpn",
            capabilities != null &&
                capabilities.hasTransport(NetworkCapabilities.TRANSPORT_VPN)
        );
        result.put(
            "validated",
            capabilities != null &&
                capabilities.hasCapability(
                    NetworkCapabilities.NET_CAPABILITY_VALIDATED
                )
        );
        result.put(
            "metered",
            capabilities == null ||
                !capabilities.hasCapability(
                    NetworkCapabilities.NET_CAPABILITY_NOT_METERED
                )
        );
        JSArray addresses = new JSArray();
        for (String address : addressStrings(properties)) {
            addresses.put(address);
        }
        result.put("addresses", addresses);
        return result;
    }

    private List<String> addressStrings(LinkProperties properties) {
        List<String> addresses = new ArrayList<>();
        if (properties == null) return addresses;
        for (LinkAddress linkAddress : properties.getLinkAddresses()) {
            InetAddress address = linkAddress.getAddress();
            if (
                address == null ||
                address.isAnyLocalAddress() ||
                address.isLoopbackAddress() ||
                address.isLinkLocalAddress() ||
                address.isMulticastAddress()
            ) {
                continue;
            }
            addresses.add(normalizedAddress(address));
        }
        addresses.removeIf(String::isEmpty);
        Collections.sort(addresses);
        return addresses;
    }

    private String normalizedAddress(InetAddress address) {
        String value = address.getHostAddress();
        if (value == null) return "";
        int zone = value.indexOf('%');
        return zone >= 0 ? value.substring(0, zone) : value;
    }

    private boolean isPrivateAddress(InetAddress address, String value) {
        if (address instanceof Inet4Address) {
            return (
                value.startsWith("10.") ||
                value.startsWith("192.168.") ||
                value.matches("^172\\.(1[6-9]|2\\d|3[01])\\..*") ||
                value.matches("^100\\.(6[4-9]|[789]\\d|1[01]\\d|12[0-7])\\..*") ||
                value.startsWith("198.18.") ||
                value.startsWith("198.19.")
            );
        }
        byte[] bytes = address.getAddress();
        return bytes.length == 16 && (bytes[0] & 0xFE) == 0xFC;
    }

    private String primaryTransport(NetworkCapabilities capabilities) {
        if (capabilities == null) return "unknown";
        if (capabilities.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) {
            return "vpn";
        }
        if (capabilities.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)) {
            return "ethernet";
        }
        if (capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) {
            return "wifi";
        }
        if (capabilities.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)) {
            return "cellular";
        }
        if (capabilities.hasTransport(NetworkCapabilities.TRANSPORT_BLUETOOTH)) {
            return "bluetooth";
        }
        return "other";
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
