import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.synced.room",
  appName: "同频",
  webDir: "dist-renderer",
  server: {
    androidScheme: "https",
  },
};

export default config;
