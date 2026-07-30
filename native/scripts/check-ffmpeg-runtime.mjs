import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

const executable = path.resolve("vendor/ffmpeg/ffmpeg.exe");
const expectedSha256 =
  "d9f64f4ffc0eab208dfcccc56e8945285ebdd9f2ab225c36d8fcdab1a08db5e1";
const digest = createHash("sha256")
  .update(readFileSync(executable))
  .digest("hex");
assert.equal(digest, expectedSha256, "FFmpeg runtime checksum mismatch");

const version = execFileSync(executable, ["-version"], {
  encoding: "utf8",
  windowsHide: true,
});
assert.match(version, /ffmpeg version n8\.1\.2-31-g8c9502e9b0-20260724/);
assert.doesNotMatch(version, /--enable-gpl(?:\s|$)/);
assert.match(version, /--disable-libx264/);
assert.match(version, /--disable-libx265/);
assert.match(version, /--enable-libopenh264/);

const muxer = execFileSync(executable, ["-hide_banner", "-h", "muxer=mp4"], {
  encoding: "utf8",
  windowsHide: true,
});
assert.match(muxer, /frag_duration/);
assert.match(muxer, /default_base_moof/);

const encoders = execFileSync(
  executable,
  ["-hide_banner", "-encoders"],
  {
    encoding: "utf8",
    windowsHide: true,
  },
);
assert.match(encoders, /^\s*A.....\s+aac\s/m);
assert.match(encoders, /^\s*V.....\s+libopenh264\s/m);

const decoders = execFileSync(
  executable,
  ["-hide_banner", "-decoders"],
  {
    encoding: "utf8",
    windowsHide: true,
  },
);
assert.match(decoders, /^\s*V.....\s+h264\s/m);
assert.match(decoders, /^\s*V.....\s+hevc\s/m);

const demuxers = execFileSync(
  executable,
  ["-hide_banner", "-demuxers"],
  {
    encoding: "utf8",
    windowsHide: true,
  },
);
assert.match(demuxers, /^\s*D\s+hls\s/m);
assert.match(demuxers, /^\s*D\s+matroska,webm\s/m);
assert.match(demuxers, /^\s*D\s+mov,mp4,m4a,3gp,3g2,mj2\s/m);

console.log(
  JSON.stringify({
    ok: true,
    version: version.split(/\r?\n/, 1)[0],
    sha256: digest,
    license: "LGPL variant; GPL-only x264/x265 disabled",
  }),
);
