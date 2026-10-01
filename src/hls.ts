const URI_TAGS = new Set([
  "#EXT-X-MEDIA",
  "#EXT-X-I-FRAME-STREAM-INF",
  "#EXT-X-KEY",
  "#EXT-X-MAP",
  "#EXT-X-SESSION-KEY",
  "#EXT-X-SESSION-DATA",
  "#EXT-X-PART",
  "#EXT-X-PRELOAD-HINT",
  "#EXT-X-RENDITION-REPORT",
  "#EXT-X-CONTENT-STEERING",
  "#EXT-X-IMAGE-STREAM-INF",
]);

const AUTH_PARAMETERS = ["hdnts", "hdntl", "hdnea"];

function attributeValue(line: string, name: string): string | undefined {
  const match = line.match(new RegExp(`(?:^|[:,])${name}=(?:"([^"]*)"|([^,]*))`));
  return match?.[1] ?? match?.[2];
}

function resolveVariables(value: string, variables: Map<string, string>): string {
  return value.replace(/\{\$([A-Za-z0-9_-]+)\}/g, (_match, name: string) => {
    const resolved = variables.get(name);
    if (resolved === undefined) throw new Error(`Unresolved HLS variable: ${name}`);
    return resolved;
  });
}

export function rewriteHlsUri(uri: string, playlistUrl: URL, sessionToken: string): string {
  const target = new URL(uri, playlistUrl);
  if (target.origin !== playlistUrl.origin) {
    throw new Error("Cross-origin HLS URI rejected");
  }
  for (const parameter of AUTH_PARAMETERS) target.searchParams.delete(parameter);
  target.searchParams.set("hdntl", sessionToken);
  const latency = playlistUrl.searchParams.get("latency");
  if (latency && target.pathname.endsWith(".m3u8")) target.searchParams.set("latency", latency);
  return `${target.pathname}${target.search}${target.hash}`;
}

export function mapPlaylistUris(
  playlist: string,
  playlistUrl: URL,
  mapUri: (uri: string, playlistUrl: URL) => string,
): string {
  if (!playlist.trimStart().startsWith("#EXTM3U")) throw new Error("Object is not an HLS playlist");

  const variables = new Map<string, string>();
  const lines = playlist.split(/\r?\n/);
  const rewritten = lines.map((line) => {
    if (line.startsWith("#EXT-X-DEFINE:")) {
      if (attributeValue(line, "IMPORT")) throw new Error("Imported HLS variables are not supported");
      const name = attributeValue(line, "NAME");
      const literal = attributeValue(line, "VALUE");
      const queryParameter = attributeValue(line, "QUERYPARAM");
      if (name && literal !== undefined) variables.set(name, literal);
      if (name && queryParameter) {
        const value = playlistUrl.searchParams.get(queryParameter);
        if (value === null) throw new Error(`Missing HLS query variable: ${queryParameter}`);
        variables.set(name, value);
      }
      return line;
    }

    if (!line) return line;
    if (!line.startsWith("#")) return mapUri(resolveVariables(line, variables), playlistUrl);

    const separator = line.indexOf(":");
    const tag = separator < 0 ? line : line.slice(0, separator);
    const hasUri = /(?:^|,)(?:URI|SERVER-URI)=/.test(separator < 0 ? "" : line.slice(separator + 1));
    if (!hasUri) return line;
    if (!URI_TAGS.has(tag)) throw new Error(`Unsupported URI-bearing HLS tag: ${tag}`);

    return line.replace(/((?:[:,])(?:URI|SERVER-URI)=)(?:"([^"]*)"|([^,\r\n]*))/g, (_match, prefix, quoted, bare) => {
      const value = resolveVariables(quoted ?? bare, variables);
      const uri = mapUri(value, playlistUrl);
      return `${prefix}"${uri}"`;
    });
  });

  return rewritten.join("\n");
}

export function rewritePlaylist(playlist: string, playlistUrl: URL, sessionToken: string): string {
  return mapPlaylistUris(playlist, playlistUrl, (uri, baseUrl) => rewriteHlsUri(uri, baseUrl, sessionToken));
}

export function tailMediaPlaylist(playlist: string, maxSegments: number): string {
  if (!playlist.trimStart().startsWith("#EXTM3U")) throw new Error("Object is not an HLS playlist");
  const lines = playlist.split(/\r?\n/);
  const segmentStarts: number[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].startsWith("#EXTINF:")) segmentStarts.push(index);
  }
  if (segmentStarts.length <= maxSegments) return playlist.endsWith("\n") ? playlist : `${playlist}\n`;

  const keepAt = segmentStarts.length - maxSegments;
  const removed = keepAt;
  const bodyStart = segmentStarts[0];
  let keptBodyStart = segmentStarts[keepAt];
  while (keptBodyStart > bodyStart) {
    const prior = lines[keptBodyStart - 1];
    if (!prior.startsWith("#EXT-X-PROGRAM-DATE-TIME") && !prior.startsWith("#EXT-X-DISCONTINUITY")) break;
    keptBodyStart -= 1;
  }
  const header = lines.slice(0, bodyStart).filter((line) => line !== "#EXT-X-ENDLIST");
  const sequenceIndex = header.findIndex((line) => line.startsWith("#EXT-X-MEDIA-SEQUENCE:"));
  if (sequenceIndex >= 0) {
    const sequence = Number(header[sequenceIndex].slice("#EXT-X-MEDIA-SEQUENCE:".length));
    if (Number.isSafeInteger(sequence)) header[sequenceIndex] = `#EXT-X-MEDIA-SEQUENCE:${sequence + removed}`;
  }
  return `${[...header, ...lines.slice(keptBodyStart)].join("\n").replace(/^\n+/, "").trimEnd()}\n`;
}

function addLiveSequence(uri: string, sequence: number): string {
  const fragmentIndex = uri.indexOf("#");
  const fragment = fragmentIndex >= 0 ? uri.slice(fragmentIndex) : "";
  const base = fragmentIndex >= 0 ? uri.slice(0, fragmentIndex) : uri;
  return `${base}${base.includes("?") ? "&" : "?"}live_seq=${sequence}${fragment}`;
}

export function projectLivePlaylist(playlist: string, nowMs = Date.now(), windowSize = 6): string {
  if (!playlist.trimStart().startsWith("#EXTM3U")) throw new Error("Object is not an HLS playlist");
  const lines = playlist.split(/\r?\n/);
  const segments: Array<{ duration: number; durationLine: string; uri: string }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].startsWith("#EXTINF:")) continue;
    const duration = Number(lines[index].slice("#EXTINF:".length).split(",", 1)[0]);
    const uri = lines.slice(index + 1).find((line) => Boolean(line) && !line.startsWith("#"));
    if (!uri || !Number.isFinite(duration) || duration <= 0) throw new Error("Invalid HLS media segment");
    segments.push({ duration, durationLine: lines[index], uri });
  }
  if (!segments.length) throw new Error("Live projection requires a media playlist");

  const segmentDurationMs = Math.round(segments[0].duration * 1000);
  const targetDuration = Math.ceil(Math.max(...segments.map((segment) => segment.duration)));
  const latestSequence = Math.floor(nowMs / segmentDurationMs);
  const firstSequence = Math.max(0, latestSequence - Math.max(2, windowSize) + 1);
  const output = [
    "#EXTM3U",
    "#EXT-X-VERSION:6",
    `#EXT-X-TARGETDURATION:${targetDuration}`,
    `#EXT-X-MEDIA-SEQUENCE:${firstSequence}`,
    `#EXT-X-DISCONTINUITY-SEQUENCE:${Math.floor(firstSequence / segments.length)}`,
    "#EXT-X-INDEPENDENT-SEGMENTS",
  ];
  for (let sequence = firstSequence; sequence <= latestSequence; sequence += 1) {
    const sourceIndex = sequence % segments.length;
    if (sequence > firstSequence && sourceIndex === 0) output.push("#EXT-X-DISCONTINUITY");
    output.push(`#EXT-X-PROGRAM-DATE-TIME:${new Date(sequence * segmentDurationMs).toISOString()}`);
    output.push(segments[sourceIndex].durationLine);
    output.push(addLiveSequence(segments[sourceIndex].uri, sequence));
  }
  return `${output.join("\n")}\n`;
}
