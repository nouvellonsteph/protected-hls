#!/bin/sh
set -eu

: "${INGEST_BASE_URL:?INGEST_BASE_URL is required}"
SOURCE="${SOURCE:-primary}"
HLS_START_NUMBER="${HLS_START_NUMBER:-$(date +%s)}"
START_AT_EPOCH="${START_AT_EPOCH:-$HLS_START_NUMBER}"
FFMPEG_PID_PATH=/tmp/ffmpeg.pid
STATUS_ROOT=/tmp/status
mkdir -p "$STATUS_ROOT"
printf 'ok\n' > "$STATUS_ROOT/ping"

write_status() {
  running="$1"
  last_error="${2:-}"
  if [ -n "$last_error" ]; then
    error_json=",\"lastError\":\"$last_error\""
  else
    error_json=""
  fi
  printf '{"running":%s,"generator":"ffmpeg","delivery":"native HTTP PUT","source":"%s","eventId":"%s","rendition":"%s","hlsStartNumber":%s,"dvrLocation":"R2"%s}\n' \
    "$running" "$SOURCE" "${EVENT_ID:-container-demo}" "${RENDITION:-360p}" "$HLS_START_NUMBER" "$error_json" \
    > "$STATUS_ROOT/status.tmp"
  mv "$STATUS_ROOT/status.tmp" "$STATUS_ROOT/status"
}

write_status false
busybox httpd -f -p 8080 -h "$STATUS_ROOT" &
server_pid=$!
ffmpeg_pid=""

cleanup() {
  trap - EXIT INT TERM
  if [ -n "$ffmpeg_pid" ]; then
    kill "$ffmpeg_pid" 2>/dev/null || true
    wait "$ffmpeg_pid" 2>/dev/null || true
  fi
  kill "$server_pid" 2>/dev/null || true
  wait "$server_pid" 2>/dev/null || true
  rm -f "$FFMPEG_PID_PATH"
  exit 0
}
trap cleanup EXIT INT TERM

while [ "$(date +%s)" -lt "$START_AT_EPOCH" ]; do
  sleep 0.1
done

while true; do
  now="$(date +%s)"
  elapsed=$((now - START_AT_EPOCH))
  if [ "$elapsed" -lt 0 ]; then
    elapsed=0
  fi
  segment_slot=$(((elapsed + 1) / 2))
  slot_epoch=$((START_AT_EPOCH + segment_slot * 2))
  while [ "$(date +%s)" -lt "$slot_epoch" ]; do
    sleep 0.1
  done
  start_number=$((HLS_START_NUMBER + segment_slot))
  timestamp_offset=$((segment_slot * 2))
  ffmpeg \
    -hide_banner \
    -loglevel warning \
    -re \
    -f lavfi \
    -i "testsrc2=size=640x360:rate=30" \
    -f lavfi \
    -i "anullsrc=channel_layout=stereo:sample_rate=48000" \
    -vf "drawtext=fontfile=/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf:text='Managed $SOURCE | %{gmtime} UTC':fontcolor=white:fontsize=24:box=1:boxcolor=black@0.68:boxborderw=12:x=(w-text_w)/2:y=h-text_h-28,format=yuv420p" \
    -c:v libx264 \
    -preset ultrafast \
    -tune zerolatency \
    -profile:v main \
    -sc_threshold 0 \
    -g 60 \
    -keyint_min 60 \
    -b:v 800k \
    -maxrate 900k \
    -bufsize 1600k \
    -c:a aac \
    -b:a 96k \
    -ac 2 \
    -ar 48000 \
    -output_ts_offset "$timestamp_offset" \
    -f hls \
    -hls_time 2 \
    -hls_list_size 30 \
    -start_number "$start_number" \
    -hls_flags independent_segments+program_date_time+omit_endlist \
    -method PUT \
    -hls_segment_filename "$INGEST_BASE_URL/segment_%010d.ts" \
    "$INGEST_BASE_URL/index.m3u8" &
  ffmpeg_pid=$!
  printf '%s\n' "$ffmpeg_pid" > "$FFMPEG_PID_PATH"
  write_status true
  if wait "$ffmpeg_pid"; then
    write_status false "FFmpeg exited unexpectedly"
  else
    status=$?
    write_status false "FFmpeg exited with status $status"
  fi
  ffmpeg_pid=""
  rm -f "$FFMPEG_PID_PATH"
  sleep 1
done
