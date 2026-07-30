import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const {
  AUDIO_PACKET_HEADER_BYTES,
  AUDIO_PACKET_MAGIC,
  AUDIO_PACKET_VERSION,
  AudioPacketDecoder,
} = require("../electron/audio-packet.cjs");

function packet({
  pcm,
  sampleRate = 48_000,
  capturedAtUnix100ns = 17_850_000_000_000_000n,
  devicePosition = 96_000n,
}) {
  const header = Buffer.alloc(AUDIO_PACKET_HEADER_BYTES);
  AUDIO_PACKET_MAGIC.copy(header, 0);
  header.writeUInt16LE(AUDIO_PACKET_VERSION, 4);
  header.writeUInt16LE(AUDIO_PACKET_HEADER_BYTES, 6);
  header.writeUInt32LE(pcm.length, 8);
  header.writeUInt32LE(sampleRate, 12);
  header.writeBigInt64LE(capturedAtUnix100ns, 16);
  header.writeBigUInt64LE(devicePosition, 24);
  return Buffer.concat([header, pcm]);
}

test("decodes timestamped PCM packets across arbitrary pipe chunks", () => {
  const pcm = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
  const encoded = packet({ pcm });
  const decoded = [];
  const decoder = new AudioPacketDecoder((value) => decoded.push(value));

  decoder.push(encoded.subarray(0, 3));
  decoder.push(encoded.subarray(3, 19));
  decoder.push(encoded.subarray(19, 34));
  decoder.push(encoded.subarray(34));

  assert.equal(decoded.length, 1);
  assert.deepEqual(decoded[0].pcm, pcm);
  assert.equal(decoded[0].sampleRate, 48_000);
  assert.equal(decoded[0].devicePosition, 96_000);
  assert.equal(decoded[0].capturedAtUnixMs, 1_785_000_000_000);
});

test("resynchronizes at the next packet after malformed bytes", () => {
  const decoded = [];
  const decoder = new AudioPacketDecoder((value) => decoded.push(value));
  const valid = packet({
    pcm: Buffer.from([9, 10, 11, 12]),
    devicePosition: 192_000n,
  });

  decoder.push(Buffer.concat([Buffer.from("broken-frame"), valid]));

  assert.equal(decoded.length, 1);
  assert.deepEqual(decoded[0].pcm, Buffer.from([9, 10, 11, 12]));
  assert.equal(decoded[0].devicePosition, 192_000);
});
