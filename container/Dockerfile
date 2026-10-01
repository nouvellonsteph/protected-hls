FROM mwader/static-ffmpeg:8.0@sha256:be54ba2c55ddb7e2f8307490cd060099819c7cfa487f1d66c139088b1e057727 AS ffmpeg
FROM jrottenberg/ffmpeg:8.0-alpine@sha256:d73aef90239e7f685a49a8c7290dd6118db5b7e4f82988ba4a16ba0154d5f24c AS fonts
FROM busybox:1.37.0-musl@sha256:dc88b80842580654294472735332ec7c7789a4010ec9a68b69f9b88c19abede6 AS health

FROM alpine:3.23

COPY --from=ffmpeg /ffmpeg /bin/ffmpeg
COPY --from=ffmpeg /ffprobe /bin/ffprobe
COPY --from=fonts /usr/share/fonts /usr/share/fonts
COPY --from=health /bin/busybox /bin/busybox

RUN addgroup -S live && adduser -S live -G live

COPY --chown=live:live start.sh /app/start.sh
RUN chmod +x /app/start.sh

USER live
EXPOSE 8080

ENTRYPOINT ["/app/start.sh"]
