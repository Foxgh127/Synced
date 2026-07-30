import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.yiqikan.room",
  appName: "同频",
  webDir: "dist-renderer",
  server: {
    androidScheme: "https",
  },
};

export default config;
