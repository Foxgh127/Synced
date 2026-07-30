export {};

declare global {
  interface Window {
    roomDesktop?: {
      loadChannelOwnership: () =>
        | { room: string; ownerToken: string }
        | undefined;
      saveChannelOwnership: (value: {
        room: string;
        ownerToken: string;
      }) => boolean;
      requestMediaPermissionIntent: (
        kind: "microphone",
      ) => Promise<boolean>;
      releaseMediaPermission: (kind: "microphone") => void;
      listSources: (options?: {
        thumbnails?: boolean;
        audioProcesses?: boolean;
      }) => Promise<CaptureSource[]>;
      selectSource: (sourceId: string) => Promise<CaptureSelection>;
      getCaptureSourceHealth: () => Promise<CaptureSourceHealth>;
      ensurePortableFirewall: () => Promise<{
        portable: boolean;
        configured: boolean;
        repaired: boolean;
      }>;
      startProcessAudio: () => Promise<ProcessAudioStatus>;
      getProcessAudioStatus: () => Promise<ProcessAudioDiagnostics>;
      stopProcessAudio: (captureId?: number) => Promise<void>;
      onProcessAudioData: (
        callback: (packet: ProcessAudioPacket) => void,
      ) => () => void;
      onProcessAudioStatus: (callback: (status: ProcessAudioStatus) => void) => () => void;
      onOpenUrl: (callback: (url: string) => void) => () => void;
      setCaptureActive: (active: boolean) => Promise<void>;
      setDesktopDanmakuActive: (active: boolean) => void;
      showDanmaku: (nickname: string, text: string, mine: boolean) => void;
      clearDanmaku: () => void;
      setMiniWindowEnabled: (enabled: boolean) => void;
      restoreFromPictureInPicture: () => Promise<void>;
      onMainWindowRestored: (callback: () => void) => () => void;
      gameViewOpen: (
        bounds: EmbeddedGameBounds,
      ) => Promise<{ url: string }>;
      gameViewSetBounds: (bounds: EmbeddedGameBounds) => Promise<void>;
      gameViewHide: () => Promise<void>;
      gameViewReload: () => Promise<boolean>;
      gameViewBack: () => Promise<boolean>;
      onGameViewState: (
        callback: (state: EmbeddedGameState) => void,
      ) => () => void;
      reportDiagnostic: (
        event: string,
        detail?: Record<string, unknown>,
      ) => void;
      getVersion: () => Promise<string>;
      getNetworkInfo: () => Promise<{
        lanAddresses: string[];
        hasVirtualTunnel: boolean;
        virtualInterfaces: string[];
      }>;
      writeClipboard: (text: string) => Promise<void>;
      readClipboard: () => Promise<string>;
      getDisplayInfo: () => Promise<{
        width: number;
        height: number;
        refreshRate: number;
        scaleFactor: number;
        colorSpace: string;
        depthPerComponent: number;
        hdr: boolean;
      }>;
      openDisplaySettings: () => Promise<void>;
      embyLogin: (input: EmbyLoginInput) => Promise<EmbyAccount>;
      embyLogout: () => Promise<EmbyAccountState>;
      embyAccounts: () => Promise<EmbyAccountState>;
      embyActivateAccount: (accountId: string) => Promise<EmbyAccount>;
      embyUpdateEndpoints: (
        accountId: string,
        input: { serverUrls: string[]; allowInsecure?: boolean },
      ) => Promise<EmbyAccount>;
      embySearchAll: (input: {
        searchTerm: string;
        includeItemTypes?: string[];
        limit?: number;
        filters?: Array<"IsResumable" | "IsUnplayed" | "IsPlayed">;
        sortBy?: string;
        sortOrder?: "Ascending" | "Descending";
      }) => Promise<{
        items: EmbyLibraryItem[];
        total: number;
        serverCount: number;
        failedServers: string[];
      }>;
      embyListViews: (input?: {
        accountId?: string;
      }) => Promise<EmbyLibraryItem[]>;
      embyListItems: (input: {
        accountId?: string;
        parentId?: string;
        searchTerm?: string;
        recursive?: boolean;
        includeItemTypes?: string[];
        limit?: number;
        startIndex?: number;
        filters?: Array<"IsResumable" | "IsUnplayed" | "IsPlayed">;
        sortBy?:
          | "SortName"
          | "DateCreated"
          | "DatePlayed"
          | "PremiereDate"
          | "ProductionYear"
          | string;
        sortOrder?: "Ascending" | "Descending";
      }) => Promise<{ items: EmbyLibraryItem[]; total: number }>;
      embyImageData: (input: {
        itemId: string;
        tag?: string;
        accountId?: string;
      }) => Promise<string>;
      embyPlaybackInfo: (
        input: EmbyPlaybackRequest,
      ) => Promise<EmbyPlaybackInfo>;
      embyStartStream: (
        input: EmbyPlaybackRequest,
      ) => Promise<{ pipelineId: string; plan: EmbyStreamPlan }>;
      embyStopStream: (
        reason?: string,
        expectedPipelineId?: string,
      ) => Promise<void>;
      embySetFlowPaused: (
        paused: boolean,
        expectedPipelineId?: string,
        generation?: number,
      ) => Promise<{
        pipelineId: string;
        generation: number;
        actualPaused: boolean;
        applied: boolean;
      }>;
      embyGetFlowState: (
        expectedPipelineId?: string,
      ) => Promise<{
        pipelineId: string;
        actualPaused: boolean;
        active: boolean;
      }>;
      embyUpdateSegmentRelay?: (input: {
        token: string;
        expiresAt: number;
      }) => Promise<{ updated: boolean; pipelineId: string }>;
      embyUpdateRenditionDemand?: (input: {
        original?: boolean;
        high?: boolean;
        low?: boolean;
        availableUploadBps?: number;
      }) => Promise<{
        updated: boolean;
        active: string[];
        uploadBudgetBps: number;
        pipelineId: string;
      }>;
      embyReportPlayback: (input: {
        action: "start" | "progress" | "stop";
        positionTicks: number;
        isPaused?: boolean;
        eventName?: string;
      }) => Promise<void>;
      onEmbyStreamEvent: (
        callback: (event: EmbyStreamEvent) => void,
      ) => () => void;
      platform: string;
    };
    __syncedEnterMiniWindowForMinimize?: () => Promise<boolean>;
  }

  interface EmbeddedGameBounds {
    x: number;
    y: number;
    width: number;
    height: number;
  }

  interface EmbeddedGameState {
    state: "loading" | "ready" | "error";
    message?: string;
  }

  interface CaptureSource {
    id: string;
    name: string;
    thumbnail?: string;
    appIcon?: string;
    processId?: number;
    processName?: string;
    executableName?: string;
  }

  interface CaptureSelection {
    id: string;
    name: string;
    windowHandle?: string;
    processId?: number;
  }

  interface CaptureSourceHealth {
    available: boolean;
    activity: number;
    changed: boolean;
    selectedId?: string;
    sourceId?: string;
    name?: string;
    width?: number;
    height?: number;
    foreground?: boolean;
    visible?: boolean;
    minimized?: boolean;
  }

  interface ProcessAudioStatus {
    type: "ready" | "error" | "stopped" | "window" | "flow";
    message?: string;
    captureId?: number;
    code?: number | null;
    processId?: number;
    sampleRate?: number;
    channels?: number;
    bitsPerSample?: number;
    latencyMs?: number;
    packetCount?: number;
    byteCount?: number;
    left?: number;
    top?: number;
    width?: number;
    height?: number;
    visible?: boolean;
    foreground?: boolean;
    minimized?: boolean;
  }

  interface ProcessAudioPacket {
    pcm: Uint8Array;
    sampleRate: number;
    capturedAtUnixMs: number;
    devicePosition: number;
    captureId: number;
  }

  interface ProcessAudioDiagnostics {
    captureId: number;
    active: boolean;
    starting: boolean;
    packetCount: number;
    byteCount: number;
    lastPacketAt: number;
    lastPacketAgeMs?: number;
    sourceHandle?: string;
    processId?: number;
    sampleRate?: number;
    channels?: number;
    bitsPerSample?: number;
    latencyMs?: number;
    startedAt?: number;
    stoppedAt?: number;
    stopReason?: string;
    exitCode?: number | null;
    lastError?: string;
  }

  interface EmbyLoginInput {
    serverUrl: string;
    serverUrls?: string[];
    username: string;
    password: string;
    allowInsecure?: boolean;
  }

  interface EmbyLoginResult {
    user: { id: string; name: string };
    server: {
      name: string;
      version?: string;
      address: string;
      insecure: boolean;
      id?: string;
      activeEndpointId?: string;
      endpoints?: Array<{
        id: string;
        url: string;
        label: string;
        priority: number;
        active: boolean;
      }>;
    };
  }

  interface EmbyAccount extends EmbyLoginResult {
    id: string;
    lastUsedAt: number;
  }

  interface EmbyAccountState {
    accounts: EmbyAccount[];
    activeAccountId?: string;
    persistence: "encrypted" | "session-only";
  }

  interface EmbyLibraryItem {
    id: string;
    name: string;
    type: string;
    productionYear?: number;
    seriesName?: string;
    seasonName?: string;
    indexNumber?: number;
    parentIndexNumber?: number;
    runtimeTicks?: number;
    overview?: string;
    imageTag?: string;
    imageItemId?: string;
    playbackPositionTicks?: number;
    playedPercentage?: number;
    played?: boolean;
    dateCreated?: string;
    premiereDate?: string;
    officialRating?: string;
    communityRating?: number;
    genres?: string[];
    studios?: string[];
    taglines?: string[];
    accountId?: string;
    serverName?: string;
  }

  interface EmbyMediaStream {
    index: number;
    type: string;
    codec: string;
    language?: string;
    title?: string;
    channels?: number;
    width?: number;
    height?: number;
    frameRate?: number;
    bitRate?: number;
    bitDepth?: number;
    profile?: string;
    pixelFormat?: string;
    isDefault?: boolean;
    isForced?: boolean;
    isExternal?: boolean;
    isText?: boolean;
    deliveryMethod?: string;
  }

  interface EmbyPlaybackRequest {
    accountId?: string;
    itemId: string;
    mediaSourceId?: string;
    quality:
      | "original"
      | "4k-18"
      | "4k-12"
      | "1440p-18"
      | "1080p-12"
      | "1080p-8"
      | "720p-6"
      | "720p-4"
      | "480p-2.5"
      | "360p-1.2";
    startTimeTicks?: number;
    audioStreamIndex?: number;
    subtitleStreamIndex?: number;
    frameRate?: 24 | 30 | 60;
    allowHevc?: boolean;
    /** Internal compatibility recovery; not exposed as a user setting. */
    forceVideoTranscode?: boolean;
    /** Internal authenticated CMAF relay configuration. */
    segmentRelay?: {
      baseUrl: string;
      token: string;
      roomId: string;
      sessionId: string;
      mediaVersion: number;
      assetId: string;
    };
    /** Internal rendition worker marker. */
    renditionId?: string;
    singleRendition?: boolean;
    title?: string;
    skipSubtitle?: boolean;
  }

  interface EmbyPlaybackInfo {
    playSessionId: string;
    mediaSources: Array<{
      id: string;
      name: string;
      container: string;
      bitrate?: number;
      runtimeTicks?: number;
      supportsDirectPlay: boolean;
      supportsDirectStream: boolean;
      supportsTranscoding: boolean;
      streams: EmbyMediaStream[];
    }>;
    quality: {
      key: string;
      label: string;
      maxBitrate: number;
      maxWidth: number;
      maxHeight: number;
      forceTranscode: boolean;
    };
  }

  interface EmbyStreamPlan {
    itemId: string;
    mediaSourceId: string;
    playSessionId: string;
    method: "DirectPlay" | "DirectStream" | "Transcode" | "LocalRemux";
    quality: EmbyPlaybackInfo["quality"];
    video: EmbyMediaStream;
    audio: EmbyMediaStream;
    videoCodec: string;
    audioCodec: string;
    localAudioTranscode: boolean;
    subtitleMode?: "none" | "external" | "burn-in";
    width: number;
    height: number;
    frameRate: number;
    bitrate: number;
    runtimeTicks?: number;
    startTimeTicks: number;
    localVideoEncoder?: "h264_nvenc" | "h264_qsv" | "h264_amf" | "libopenh264";
  }

  type EmbyStreamEvent =
    | {
        type: "started";
        pipelineId: string;
        plan: EmbyStreamPlan;
        renditionId?: string;
        auxiliary?: boolean;
      }
    | {
        type: "init";
        pipelineId: string;
        data: Uint8Array;
        mimeType: string;
        plan: EmbyStreamPlan;
        renditionId?: string;
        auxiliary?: boolean;
      }
    | {
        type: "fragment";
        pipelineId: string;
        sequence: number;
        timestampMs: number;
        mediaTimeMs: number;
        keyframe: boolean;
        timelineRepairs?: Array<{
          sequence: number;
          trackId: number;
          trackType: string;
          rawTimeMs: number;
          timelineTimeMs: number;
          timestampOffsetMs: number;
        }>;
        data: Uint8Array;
        renditionId?: string;
        auxiliary?: boolean;
      }
    | {
        type: "subtitle";
        pipelineId: string;
        subtitle: {
          supported: boolean;
          codec?: string;
          language?: string;
          title?: string;
          text?: string;
          message?: string;
        };
        renditionId?: string;
        auxiliary?: boolean;
      }
    | {
        type: "warning";
        pipelineId: string;
        code: string;
        message: string;
        renditionId?: string;
        auxiliary?: boolean;
      }
    | {
        type: "ended" | "error" | "stopped";
        pipelineId: string;
        message?: string;
        reason?: string;
        renditionId?: string;
        auxiliary?: boolean;
      };
}
