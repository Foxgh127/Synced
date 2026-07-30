# FFmpeg runtime

Synced uses this separate FFmpeg executable for Emby stream demuxing and
fragmented-MP4 remuxing. It is not linked into the application.

- Build: `n8.1.2-31-g8c9502e9b0-20260724`, Windows x86-64, LGPL static variant
- Upstream build project: https://github.com/BtbN/FFmpeg-Builds
- Pinned archive:
  https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-07-24-13-32/ffmpeg-n8.1.2-31-g8c9502e9b0-win64-lgpl-8.1.zip
- Archive SHA-256:
  `972c57498dff104fff2d53b8b0cb3641f45b8ff1e7cc1b00257c9e34435fe853`
- Corresponding FFmpeg source commit:
  https://github.com/FFmpeg/FFmpeg/commit/8c9502e9b0

The bundled `LICENSE.txt` is the license text shipped by the pinned build.
`ffmpeg -version` is checked during the release build to reject binaries that
enable GPL-only components.
