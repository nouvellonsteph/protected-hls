#!/usr/bin/env bash
set -euo pipefail

ROOT="${1:-media/demo}"
mkdir -p "$ROOT/720p" "$ROOT/360p"

generate_rendition() {
  local size="$1"
  local bitrate="$2"
  local output="$3"
  ffmpeg -hide_banner -loglevel error -y \
    -f lavfi -i "testsrc2=size=${size}:rate=30:duration=12" \
    -f lavfi -i "sine=frequency=660:sample_rate=48000:duration=12" \
    -c:v libx264 -preset veryfast -pix_fmt yuv420p -b:v "$bitrate" \
    -g 60 -keyint_min 60 -sc_threshold 0 \
    -c:a aac -b:a 96k -ac 2 -shortest \
    -f hls -hls_time 2 -hls_playlist_type vod -hls_flags independent_segments \
    -hls_segment_filename "$output/segment-%03d.ts" "$output/index.m3u8"
}

generate_rendition "1280x720" "1600k" "$ROOT/720p"
generate_rendition "640x360" "700k" "$ROOT/360p"

cat > "$ROOT/master.m3u8" <<'EOF'
#EXTM3U
#EXT-X-VERSION:3
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-STREAM-INF:BANDWIDTH=1800000,AVERAGE-BANDWIDTH=1500000,RESOLUTION=1280x720,FRAME-RATE=30.000,CODECS="avc1.64001f,mp4a.40.2"
720p/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=850000,AVERAGE-BANDWIDTH=650000,RESOLUTION=640x360,FRAME-RATE=30.000,CODECS="avc1.64001e,mp4a.40.2"
360p/index.m3u8
EOF

printf 'Generated protected HLS demo media in %s\n' "$ROOT"
