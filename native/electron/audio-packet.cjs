"use strict";

const AUDIO_PACKET_MAGIC = Buffer.from("YQAP", "ascii");
const AUDIO_PACKET_VERSION = 1;
const AUDIO_PACKET_HEADER_BYTES = 32;
const MAX_AUDIO_PACKET_BYTES = 4 * 1024 * 1024;

class AudioPacketDecoder {
  constructor(onPacket) {
    if (typeof onPacket !== "function") {
      throw new TypeError("AudioPacketDecoder requires an onPacket callback");
    }
    this.onPacket = onPacket;
    this.buffer = Buffer.alloc(0);
  }

  push(chunk) {
    if (!chunk?.length) return;
    const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.buffer = this.buffer.length
      ? Buffer.concat([this.buffer, incoming])
      : incoming;
    this.decodeAvailablePackets();
  }

  reset() {
    this.buffer = Buffer.alloc(0);
  }

  decodeAvailablePackets() {
    while (this.buffer.length >= AUDIO_PACKET_HEADER_BYTES) {
      if (!this.buffer.subarray(0, 4).equals(AUDIO_PACKET_MAGIC)) {
        const nextMagic = this.buffer.indexOf(AUDIO_PACKET_MAGIC, 1);
        if (nextMagic < 0) {
          this.buffer = this.buffer.subarray(
            Math.max(0, this.buffer.length - AUDIO_PACKET_MAGIC.length + 1),
          );
          return;
        }
        this.buffer = this.buffer.subarray(nextMagic);
        continue;
      }

      const version = this.buffer.readUInt16LE(4);
      const headerBytes = this.buffer.readUInt16LE(6);
      const payloadBytes = this.buffer.readUInt32LE(8);
      const sampleRate = this.buffer.readUInt32LE(12);
      if (
        version !== AUDIO_PACKET_VERSION ||
        headerBytes !== AUDIO_PACKET_HEADER_BYTES ||
        payloadBytes === 0 ||
        payloadBytes > MAX_AUDIO_PACKET_BYTES ||
        payloadBytes % 4 !== 0 ||
        sampleRate === 0
      ) {
        this.buffer = this.buffer.subarray(1);
        continue;
      }

      const packetBytes = headerBytes + payloadBytes;
      if (this.buffer.length < packetBytes) return;
      const capturedAtUnix100ns = this.buffer.readBigInt64LE(16);
      const devicePosition = this.buffer.readBigUInt64LE(24);
      const pcm = Buffer.from(
        this.buffer.subarray(headerBytes, packetBytes),
      );
      this.buffer = this.buffer.subarray(packetBytes);
      this.onPacket({
        pcm,
        sampleRate,
        capturedAtUnixMs: Number(capturedAtUnix100ns) / 10_000,
        devicePosition: Number(devicePosition),
      });
    }
  }
}

module.exports = {
  AUDIO_PACKET_HEADER_BYTES,
  AUDIO_PACKET_MAGIC,
  AUDIO_PACKET_VERSION,
  AudioPacketDecoder,
};
