const path = require("node:path");
const { app, BrowserWindow } = require("electron");
const WebSocket = require("ws");
const ownerTools = require("./channel-owner.cjs");

const signalUrl =
  process.env.SYNCED_SFU_SIGNAL || "wss://synced.com.cn/signal";
const timeoutMs = Math.max(
  10_000,
  Number(process.env.SYNCED_SFU_TIMEOUT_MS) || 35_000,
);

function joinSignal({
  room,
  nickname,
  ownerToken,
  canBroadcast,
  createIfMissing,
}) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(signalUrl, { origin: "file://" });
    const timeout = setTimeout(() => {
      socket.terminate();
      reject(new Error(`等待 ${nickname} 的 SFU 凭据超时`));
    }, 10_000);
    const finish = (error, value) => {
      clearTimeout(timeout);
      if (error) {
        socket.close();
        reject(error);
      } else {
        resolve({ socket, joined: value });
      }
    };
    socket.once("open", () => {
      socket.send(
        JSON.stringify({
          type: "channel:join",
          room,
          nickname,
          channelName: "SFU 公网自检",
          canBroadcast,
          createIfMissing,
          ...(ownerToken ? { ownerToken } : {}),
        }),
      );
    });
    socket.on("message", (payload) => {
      let message;
      try {
        message = JSON.parse(payload.toString());
      } catch {
        return;
      }
      if (message.type === "channel:joined") {
        finish(undefined, message);
      } else if (message.type === "error") {
        finish(new Error(message.message || "信令服务器拒绝 SFU 自检"));
      }
    });
    socket.once("error", (error) => finish(error));
  });
}

async function main() {
  const { room, ownerToken } = ownerTools.createChannelOwner();
  const owner = await joinSignal({
    room,
    nickname: "SFU自检-放映端",
    ownerToken,
    canBroadcast: true,
    createIfMissing: true,
  });
  const viewer = await joinSignal({
    room,
    nickname: "SFU自检-观众一",
    canBroadcast: false,
    createIfMissing: false,
  });
  const lateViewer = await joinSignal({
    room,
    nickname: "SFU自检-后来加入的观众",
    canBroadcast: false,
    createIfMissing: false,
  });
  const ownerAccess = owner.joined.sfu;
  const viewerAccess = viewer.joined.sfu;
  const lateViewerAccess = lateViewer.joined.sfu;
  if (
    !ownerAccess?.token ||
    !viewerAccess?.token ||
    !lateViewerAccess?.token ||
    ownerAccess.url !== viewerAccess.url ||
    ownerAccess.url !== lateViewerAccess.url ||
    ownerAccess.room !== viewerAccess.room ||
    ownerAccess.room !== lateViewerAccess.room
  ) {
    throw new Error("信令服务器没有下发同一房间的三份 SFU 凭据");
  }

  await app.whenReady();
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  await window.loadFile(path.join(__dirname, "smoke-public-sfu.html"));

  try {
    return await window.webContents.executeJavaScript(`(async () => {
      const access = ${JSON.stringify({
        url: ownerAccess.url,
        ownerToken: ownerAccess.token,
        viewerToken: viewerAccess.token,
        lateViewerToken: lateViewerAccess.token,
        ownerId: owner.joined.clientId,
        viewerId: viewer.joined.clientId,
        lateViewerId: lateViewer.joined.clientId,
        timeoutMs,
      })};
      const {
        ConnectionState,
        Room,
        RoomEvent,
        Track
      } = globalThis.LivekitClient;
      const timeout = (promise, message, waitMs = access.timeoutMs) =>
        Promise.race([
          promise,
          new Promise((_resolve, reject) => {
            setTimeout(() => reject(new Error(message)), waitMs);
          })
        ]);
      const ownerRoom = new Room({
        adaptiveStream: false,
        dynacast: true,
        disconnectOnPageLeave: false
      });
      const viewerRoom = new Room({
        adaptiveStream: false,
        dynacast: true,
        disconnectOnPageLeave: false
      });
      const lateViewerRoom = new Room({
        adaptiveStream: false,
        dynacast: true,
        disconnectOnPageLeave: false
      });
      let canvasTrack;
      let canvasTimer;
      let dataReader;
      let lateDataReader;
      try {
        await timeout(
          Promise.all([
            ownerRoom.connect(access.url, access.ownerToken, {
              autoSubscribe: true,
              maxRetries: 1,
              peerConnectionTimeout: 10000,
              websocketTimeout: 10000
            }),
            viewerRoom.connect(access.url, access.viewerToken, {
              autoSubscribe: true,
              maxRetries: 1,
              peerConnectionTimeout: 10000,
              websocketTimeout: 10000
            })
          ]),
          "两端无法连入公网 SFU"
        );
        if (
          ownerRoom.state !== ConnectionState.Connected ||
          viewerRoom.state !== ConnectionState.Connected
        ) {
          throw new Error("SFU 房间没有进入 connected 状态");
        }
        const [ownerParticipant] = await Promise.all([
          timeout(
            new Promise((resolve) => {
              const existing =
                viewerRoom.remoteParticipants.get(access.ownerId);
              if (existing) {
                resolve(existing);
                return;
              }
              viewerRoom.on(RoomEvent.ParticipantConnected, (participant) => {
                if (participant.identity === access.ownerId) {
                  resolve(participant);
                }
              });
            }),
            "观众没有看到放映端加入 SFU"
          ),
          timeout(
            new Promise((resolve) => {
              const existing =
                ownerRoom.remoteParticipants.get(access.viewerId);
              if (existing) {
                resolve(existing);
                return;
              }
              ownerRoom.on(RoomEvent.ParticipantConnected, (participant) => {
                if (participant.identity === access.viewerId) {
                  resolve(participant);
                }
              });
            }),
            "放映端没有看到观众加入 SFU"
          )
        ]);

        const reliablePayload = new TextEncoder().encode("synced-sfu-ping");
        const reliableReceived = timeout(
          new Promise((resolve) => {
            viewerRoom.on(
              RoomEvent.DataReceived,
              (payload, participant, _kind, topic) => {
                if (
                  participant?.identity === access.ownerId &&
                  topic === "synced:sfu-smoke" &&
                  new TextDecoder().decode(payload) === "synced-sfu-ping"
                ) {
                  resolve(true);
                }
              }
            );
          }),
          "SFU 可靠控制数据没有到达观众"
        );
        await ownerRoom.localParticipant.publishData(reliablePayload, {
          reliable: true,
          topic: "synced:sfu-smoke",
          destinationIdentities: [access.viewerId]
        });
        await reliableReceived;

        const dataTrackPromise = ownerParticipant.dataTracks.getDeferred(
          "synced-sfu-data-smoke"
        );
        const localDataTrack =
          await ownerRoom.localParticipant.publishDataTrack({
            name: "synced-sfu-data-smoke"
          });
        const remoteDataTrack = await timeout(
          dataTrackPromise,
          "观众没有订阅到 SFU 数据轨"
        );
        remoteDataTrack.setPipelineOptions({ maxPartialFrames: 16 });
        dataReader = remoteDataTrack.subscribe({ bufferSize: 32 }).getReader();
        const trackFrame = dataReader.read();
        const trackPayload = new TextEncoder().encode(
          "synced-emby-data-track"
        );
        let trackResult;
        for (let attempt = 0; attempt < 20 && !trackResult; attempt += 1) {
          await localDataTrack.tryPush({ payload: trackPayload });
          await localDataTrack.flush();
          trackResult = await Promise.race([
            trackFrame,
            new Promise((resolve) => setTimeout(() => resolve(undefined), 250))
          ]);
        }
        if (
          !trackResult ||
          trackResult.done ||
          new TextDecoder().decode(trackResult.value.payload) !==
            "synced-emby-data-track"
        ) {
          throw new Error("SFU 数据轨载荷不完整");
        }

        const canvas = document.createElement("canvas");
        canvas.width = 640;
        canvas.height = 360;
        const context = canvas.getContext("2d");
        context.fillStyle = "#315cf6";
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.fillStyle = "#ffffff";
        context.font = "48px sans-serif";
        context.fillText("同频 SFU", 170, 195);
        const stream = canvas.captureStream(12);
        canvasTrack = stream.getVideoTracks()[0];
        let canvasFrame = 0;
        canvasTimer = setInterval(() => {
          canvasFrame += 1;
          context.fillStyle = canvasFrame % 2 ? "#30c786" : "#315cf6";
          context.fillRect(0, 0, 24, 24);
        }, 80);
        const subscribedVideo = timeout(
          new Promise((resolve) => {
            viewerRoom.on(
              RoomEvent.TrackSubscribed,
              (track, _publication, participant) => {
                if (
                  participant.identity === access.ownerId &&
                  track.kind === Track.Kind.Video
                ) {
                  resolve(track);
                }
              }
            );
          }),
          "观众没有订阅到 SFU 画面"
        );
        await ownerRoom.localParticipant.publishTrack(canvasTrack, {
          name: "synced-screen-video-smoke",
          source: Track.Source.ScreenShare,
          videoCodec: "h264",
          simulcast: false
        });
        const remoteVideo = await subscribedVideo;
        const element = remoteVideo.attach();
        element.muted = true;
        element.autoplay = true;
        document.body.appendChild(element);
        await timeout(element.play(), "SFU 远端视频元素没有开始播放");
        await timeout(
          new Promise((resolve) => {
            if (typeof element.requestVideoFrameCallback === "function") {
              element.requestVideoFrameCallback(() => resolve(true));
            } else {
              element.addEventListener("playing", () => resolve(true), {
                once: true
              });
            }
          }),
          "SFU 远端画面没有解码首帧"
        );

        // Join a third participant after publication has already started.
        // LiveKit must subscribe the late viewer to existing data/video tracks
        // without interrupting the first viewer.
        const lateSubscribedVideo = timeout(
          new Promise((resolve) => {
            lateViewerRoom.on(
              RoomEvent.TrackSubscribed,
              (track, _publication, participant) => {
                if (
                  participant.identity === access.ownerId &&
                  track.kind === Track.Kind.Video
                ) {
                  resolve(track);
                }
              }
            );
          }),
          "后来加入的观众没有订阅到既有 SFU 画面"
        );
        await timeout(
          lateViewerRoom.connect(access.url, access.lateViewerToken, {
            autoSubscribe: true,
            maxRetries: 1,
            peerConnectionTimeout: 10000,
            websocketTimeout: 10000
          }),
          "后来加入的观众无法连入公网 SFU"
        );
        const lateOwnerParticipant = await timeout(
          new Promise((resolve) => {
            const existing =
              lateViewerRoom.remoteParticipants.get(access.ownerId);
            if (existing) {
              resolve(existing);
              return;
            }
            lateViewerRoom.on(
              RoomEvent.ParticipantConnected,
              (participant) => {
                if (participant.identity === access.ownerId) {
                  resolve(participant);
                }
              }
            );
          }),
          "后来加入的观众没有看到放映端"
        );
        const lateRemoteDataTrack = await timeout(
          lateOwnerParticipant.dataTracks.getDeferred(
            "synced-sfu-data-smoke"
          ),
          "后来加入的观众没有订阅到既有 SFU 数据轨"
        );
        lateRemoteDataTrack.setPipelineOptions({ maxPartialFrames: 16 });
        lateDataReader = lateRemoteDataTrack
          .subscribe({ bufferSize: 32 })
          .getReader();
        const lateTrackFrame = lateDataReader.read();
        const lateTrackPayload = new TextEncoder().encode(
          "synced-late-viewer-data-track"
        );
        let lateTrackResult;
        for (
          let attempt = 0;
          attempt < 20 && !lateTrackResult;
          attempt += 1
        ) {
          await localDataTrack.tryPush({ payload: lateTrackPayload });
          await localDataTrack.flush();
          lateTrackResult = await Promise.race([
            lateTrackFrame,
            new Promise((resolve) =>
              setTimeout(() => resolve(undefined), 250)
            )
          ]);
        }
        if (
          !lateTrackResult ||
          lateTrackResult.done ||
          new TextDecoder().decode(lateTrackResult.value.payload) !==
            "synced-late-viewer-data-track"
        ) {
          throw new Error("后来加入的观众收到的数据轨载荷不完整");
        }
        const lateRemoteVideo = await lateSubscribedVideo;
        const lateElement = lateRemoteVideo.attach();
        lateElement.muted = true;
        lateElement.autoplay = true;
        document.body.appendChild(lateElement);
        await timeout(
          lateElement.play(),
          "后来加入的观众视频元素没有开始播放"
        );
        await timeout(
          new Promise((resolve) => {
            if (
              typeof lateElement.requestVideoFrameCallback === "function"
            ) {
              lateElement.requestVideoFrameCallback(() => resolve(true));
            } else {
              lateElement.addEventListener("playing", () => resolve(true), {
                once: true
              });
            }
          }),
          "后来加入的观众没有解码首帧"
        );

        const ownerSawViewerLeave = timeout(
          new Promise((resolve) => {
            ownerRoom.on(RoomEvent.ParticipantDisconnected, (participant) => {
              if (participant.identity === access.viewerId) resolve(true);
            });
          }),
          "首位观众退出后放映端没有收到 SFU 离开事件"
        );
        await viewerRoom.disconnect(false);
        await ownerSawViewerLeave;

        const postLeavePayload = new TextEncoder().encode(
          "synced-after-viewer-left"
        );
        const postLeaveReceived = timeout(
          new Promise((resolve) => {
            lateViewerRoom.on(
              RoomEvent.DataReceived,
              (payload, participant, _kind, topic) => {
                if (
                  participant?.identity === access.ownerId &&
                  topic === "synced:sfu-after-leave" &&
                  new TextDecoder().decode(payload) ===
                    "synced-after-viewer-left"
                ) {
                  resolve(true);
                }
              }
            );
          }),
          "一名观众退出后剩余观众没有继续收到 SFU 数据"
        );
        await ownerRoom.localParticipant.publishData(postLeavePayload, {
          reliable: true,
          topic: "synced:sfu-after-leave",
          destinationIdentities: [access.lateViewerId]
        });
        await postLeaveReceived;
        await timeout(
          new Promise((resolve) => {
            if (
              typeof lateElement.requestVideoFrameCallback === "function"
            ) {
              lateElement.requestVideoFrameCallback(() => resolve(true));
            } else {
              setTimeout(() => resolve(true), 250);
            }
          }),
          "一名观众退出后剩余观众的 SFU 画面停止"
        );

        return {
          ok: true,
          room: ${JSON.stringify(room)},
          serverUrl: access.url,
          participants: {
            owner: ownerRoom.remoteParticipants.size + 1,
            remainingViewer: lateViewerRoom.remoteParticipants.size + 1
          },
          lateViewerJoined: true,
          viewerLeaveIsolated: true,
          reliableData: true,
          dataTrack: true,
          screenVideo: true,
          videoCodec: remoteVideo.codec || "unknown",
          serverVersion:
            ownerRoom.engine?.latestJoinResponse?.serverVersion || "unknown"
        };
      } finally {
        if (canvasTimer) clearInterval(canvasTimer);
        if (dataReader) await dataReader.cancel().catch(() => undefined);
        if (lateDataReader) {
          await lateDataReader.cancel().catch(() => undefined);
        }
        if (canvasTrack) canvasTrack.stop();
        await Promise.all([
          ownerRoom.disconnect(false).catch(() => undefined),
          viewerRoom.disconnect(false).catch(() => undefined),
          lateViewerRoom.disconnect(false).catch(() => undefined)
        ]);
      }
    })()`, true);
  } finally {
    owner.socket.close();
    viewer.socket.close();
    lateViewer.socket.close();
    window.destroy();
  }
}

const hardTimeout = setTimeout(() => {
  console.error("public SFU smoke check exceeded its deadline");
  app.exit(1);
}, timeoutMs + 15_000);

main()
  .then((result) => {
    console.log(`SFU_SMOKE_RESULT ${JSON.stringify(result)}`);
    app.exit(0);
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.stack : String(error));
    app.exit(1);
  })
  .finally(() => {
    clearTimeout(hardTimeout);
  });
