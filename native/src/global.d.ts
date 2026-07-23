export {};

declare global {
  interface Window {
    roomDesktop?: {
      listSources: () => Promise<CaptureSource[]>;
      selectSource: (sourceId: string) => Promise<boolean>;
      setCaptureActive: (active: boolean) => Promise<void>;
      getVersion: () => Promise<string>;
      getNetworkInfo: () => Promise<{
        localSignalReady: boolean;
        lanAddresses: string[];
      }>;
      platform: string;
    };
  }

  interface CaptureSource {
    id: string;
    name: string;
    thumbnail: string;
    appIcon?: string;
  }
}
