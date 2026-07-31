import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

function source(relativePath) {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

test("large voice rooms use a dedicated microphone-only SFU room", () => {
  const server = source("server/index.mjs");
  const voice = source("src/voice.ts");
  const sfu = source("src/voice-sfu.ts");
  const companion = source("src/room-companion.ts");
  const policy = JSON.parse(source("server/protocol-policy.json"));

  assert.equal(policy.voice.maxMeshParticipantsWithoutSfu, 3);
  assert.match(server, /-voice`/);
  assert.match(server, /canPublishData: false/);
  assert.match(server, /canPublishSources: \["microphone"\]/);
  assert.match(server, /code: "voice-sfu-required"/);
  assert.match(voice, /new VoiceSfuSession\(\)/);
  assert.match(voice, /activateVoiceSfu/);
  assert.match(
    voice,
    /message\.type === "voice:signal"[\s\S]{0,180}?voiceTransport === "sfu"/,
  );
  assert.match(sfu, /name: SFU_VOICE_TRACK/);
  assert.match(sfu, /source: Track\.Source\.Microphone/);
  assert.match(sfu, /url\.protocol !== "wss:"/);
  assert.match(sfu, /VOICE_SFU_REFRESH_WINDOW_MS/);
  assert.match(sfu, /Reconnect with the refreshed token/);
  assert.match(sfu, /sessionGeneration/);
  assert.match(sfu, /publicationTail/);
  assert.match(sfu, /signal\?: AbortSignal/);
  assert.match(sfu, /generation !== this\.sessionGeneration/);
  assert.match(companion, /state\.transport === "sfu"/);
  assert.match(companion, /语音 SFU/);
});

test("voice bitrate and mesh limits come from the shared protocol policy", () => {
  const quality = source("src/voice-quality.ts");
  const server = source("server/index.mjs");
  assert.match(quality, /protocolPolicy\.voice/);
  assert.match(
    quality,
    /MAX_VOICE_MESH_PARTICIPANTS[\s\S]{0,100}?maxMeshParticipantsWithoutSfu/,
  );
  assert.match(
    server,
    /protocolPolicy\.voice\.maxMeshParticipantsWithoutSfu/,
  );
});
