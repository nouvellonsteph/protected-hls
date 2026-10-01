import { mapPlaylistUris } from "./hls";
import { isSourceRole, SOURCE_ROLES, type SourceRole } from "./source-role";
import {
  type PublicationDecision,
  type PublicationInput,
  type StreamCoordinator,
} from "./stream-coordinator";
import { constantTimeEqual } from "./token";

type CoordinatorStub = DurableObjectStub<StreamCoordinator>;

const STREAM_ID = "live-demo";
const DEMO_RENDITION = "360p";
const PRIMARY_SOURCE: SourceRole = "primary";
const LIVE_PREFIX = "live/";
const CANONICAL_MASTER_KEY = "live/master.m3u8";
const MAX_PLAYLIST_BYTES = 1_000_000;
const MAX_PLAYLIST_OBJECTS = 100;
const EXTERNAL_PUBLISH_TTL_SECONDS = 15 * 60;
const MEDIALIVE_PUBLISH_TTL_SECONDS = 6 * 60 * 60;
const MAX_PUBLISH_TOKEN_TTL_SECONDS = MEDIALIVE_PUBLISH_TTL_SECONDS;
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PLAYLIST_HTTP_METADATA = {
  contentType: "application/vnd.apple.mpegurl",
  cacheControl: "no-store",
} as const;
const SEGMENT_HTTP_METADATA = {
  contentType: "video/mp2t",
} as const;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export type ExternalPublisherClaims = {
  source: SourceRole;
  eventId: string;
  rendition: string;
  iat: number;
  exp: number;
  nonce: string;
};

type PublisherTarget = {
  source: SourceRole;
  publishBaseUrl: string;
  ingestUrl: string;
  ffmpegCommand: string;
  dockerCommand: string;
  obs: {
    outputType: string;
    containerFormat: string;
    url: string;
    muxerSettings: string;
  };
};

type PublicationResult = {
  published: boolean;
  reason: string;
  generation?: number;
  activeSource?: SourceRole | null;
};

class RetryableIngestError extends Error {}

type IngestTarget = {
  source: SourceRole;
  tokenSource: SourceRole | "live";
  eventId: string;
  rendition: string;
  objectName: string;
  publishToken?: string;
};

function json(value: unknown, status = 200, headers?: HeadersInit): Response {
  return Response.json(value, {
    status,
    headers: { "Cache-Control": "no-store", ...headers },
  });
}

function coordinator(env: Env, streamId = STREAM_ID): CoordinatorStub {
  return env.STREAM_COORDINATOR.get(env.STREAM_COORDINATOR.idFromName(streamId)) as CoordinatorStub;
}

type PublisherContainerStatus = {
  lifecycle: string;
  lastChange: number;
  process: Record<string, unknown> | null;
};

type PublisherContainerStatuses = Record<SourceRole, PublisherContainerStatus>;

function publisherContainer(env: Env, source: SourceRole) {
  return env.LIVE_PUBLISHER.getByName(`${STREAM_ID}-${source}`);
}

async function stopContainerInstance(env: Env, name: string): Promise<void> {
  const publisher = env.LIVE_PUBLISHER.getByName(name);
  const state = await publisher.getState();
  if (!state.status.startsWith("stopped")) await publisher.destroy();
}

async function stopPublisherContainers(env: Env, source?: SourceRole): Promise<void> {
  const names = source
    ? [`${STREAM_ID}-${source}`]
    : [...SOURCE_ROLES.map((role) => `${STREAM_ID}-${role}`), STREAM_ID];
  await Promise.all(names.map((name) => stopContainerInstance(env, name)));
}

async function publisherContainerStatus(env: Env, source: SourceRole): Promise<PublisherContainerStatus> {
  const publisher = publisherContainer(env, source);
  const state = await publisher.getState();
  let process: Record<string, unknown> | null = null;
  if (state.status === "healthy" || state.status === "running") {
    try {
      const response = await publisher.containerFetch("http://container/status", {}, 8080);
      if (response.ok) process = await response.json() as Record<string, unknown>;
    } catch {
      // The lifecycle state still tells the UI that startup is in progress.
    }
  }
  return { lifecycle: state.status, lastChange: state.lastChange, process };
}

async function publisherContainerStatuses(env: Env): Promise<PublisherContainerStatuses> {
  const statuses = await Promise.all(SOURCE_ROLES.map((source) => publisherContainerStatus(env, source)));
  return { primary: statuses[0], backup: statuses[1] };
}

function publisherEventId(kind: "container" | "external" | "medialive"): string {
  return `${kind}-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
}

function containerTimeline(eventId: string): { startAtEpochSeconds: number; startNumber: number } | null {
  const [kind, encodedCreatedAt] = eventId.split("-");
  if (kind !== "container" || !encodedCreatedAt) return null;
  const createdAt = Number.parseInt(encodedCreatedAt, 36);
  if (!Number.isSafeInteger(createdAt) || createdAt <= 0) return null;
  const startAtEpochSeconds = Math.floor(createdAt / 1000) + 5;
  return { startAtEpochSeconds, startNumber: startAtEpochSeconds };
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid publisher token encoding");
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function publisherSignature(payload: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return base64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, textEncoder.encode(payload))));
}

export async function issueExternalPublisherToken(claims: ExternalPublisherClaims, secret: string): Promise<string> {
  const payload = base64Url(textEncoder.encode(JSON.stringify(claims)));
  return `${payload}.${await publisherSignature(payload, secret)}`;
}

export async function verifyExternalPublisherToken(
  token: string,
  secret: string,
  expected: Omit<Pick<ExternalPublisherClaims, "source" | "eventId" | "rendition">, "source"> & {
    source: SourceRole | "live";
  },
  now = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  try {
    const parts = token.split(".");
    if (parts.length !== 2 || token.length > 1024) return false;
    const [payload, suppliedSignature] = parts;
    const expectedSignature = await publisherSignature(payload, secret);
    if (!constantTimeEqual(suppliedSignature, expectedSignature)) return false;
    const claims = JSON.parse(textDecoder.decode(decodeBase64Url(payload))) as Partial<ExternalPublisherClaims>;
    return claims.source === expected.source
      && claims.eventId === expected.eventId
      && claims.rendition === expected.rendition
      && typeof claims.nonce === "string"
      && typeof claims.iat === "number"
      && typeof claims.exp === "number"
      && claims.iat <= now + 30
      && claims.exp >= now
      && claims.exp > claims.iat
      && claims.exp - claims.iat <= MAX_PUBLISH_TOKEN_TTL_SECONDS;
  } catch {
    return false;
  }
}

function parseIngestTarget(pathname: string): IngestTarget | null {
  const parts = pathname.split("/").filter(Boolean);
  const source = parts[2] === "live" ? PRIMARY_SOURCE : parts[2];
  if (parts.length === 6 && parts[0] === "ingest" && parts[1] === STREAM_ID && isSourceRole(source)) {
    const [, , tokenSource, eventId, rendition, objectName] = parts;
    return { source, tokenSource: tokenSource as SourceRole | "live", eventId, rendition, objectName };
  }
  if (parts.length === 7 && parts[0] === "publish" && parts[1] === STREAM_ID && isSourceRole(source)) {
    const [, , tokenSource, eventId, rendition, publishToken, objectName] = parts;
    return { source, tokenSource: tokenSource as SourceRole | "live", eventId, rendition, publishToken, objectName };
  }
  return null;
}

function assertName(value: string, label: string): void {
  if (!NAME_PATTERN.test(value)) throw new Error(`Invalid ${label}`);
}

async function readPlaylist(request: Request): Promise<string> {
  const declaredSize = Number(request.headers.get("Content-Length"));
  if (declaredSize > MAX_PLAYLIST_BYTES) throw new Error("Playlist exceeds 1 MB");
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_PLAYLIST_BYTES) {
      await reader.cancel();
      throw new Error("Playlist exceeds 1 MB");
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return textDecoder.decode(body);
}

function playlistMediaSequence(playlist: string): number {
  const value = Number(/^#EXT-X-MEDIA-SEQUENCE:(\d+)$/m.exec(playlist)?.[1] ?? 0);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function contentMd5(value: string | null): Uint8Array | undefined {
  if (!value) return undefined;
  try {
    const decoded = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
    return decoded.byteLength === 16 ? decoded : undefined;
  } catch {
    return undefined;
  }
}

function checksumsMatch(left: ArrayBuffer | undefined, right: ArrayBuffer | undefined): boolean {
  if (!left || !right || left.byteLength !== right.byteLength) return false;
  const leftBytes = new Uint8Array(left);
  const rightBytes = new Uint8Array(right);
  return leftBytes.every((value, index) => value === rightBytes[index]);
}

export function canonicalizeMediaPlaylist(
  playlist: string,
  sourcePrefix: string,
): { manifest: string; objectNames: string[] } {
  const baseUrl = new URL(`https://ingest.invalid/media/${sourcePrefix}/index.m3u8`);
  const directory = baseUrl.pathname.slice(0, baseUrl.pathname.lastIndexOf("/") + 1);
  const objectNames = new Set<string>();
  const manifest = mapPlaylistUris(playlist, baseUrl, (uri, playlistUrl) => {
    const target = new URL(uri, playlistUrl);
    if (target.origin !== playlistUrl.origin || !target.pathname.startsWith(directory)) {
      throw new Error("Playlist URI escapes the source rendition");
    }
    const objectName = decodeURIComponent(target.pathname.slice(directory.length));
    assertName(objectName, "playlist object name");
    objectNames.add(objectName);
    if (objectNames.size > MAX_PLAYLIST_OBJECTS) throw new Error("Playlist references too many objects");
    return target.pathname;
  });
  return { manifest, objectNames: [...objectNames] };
}

export function classifyIngestPlaylist(objectName: string, playlist: string): "master" | "media" | "unsupported" {
  if (!playlist.trimStart().startsWith("#EXTM3U")) return "unsupported";
  if (objectName === "index.m3u8" && (playlist.includes("#EXT-X-STREAM-INF") || playlist.includes("#EXT-X-MEDIA:"))) {
    return "master";
  }
  if ((objectName === "index.m3u8" || objectName === `index-${DEMO_RENDITION}.m3u8`) && playlist.includes("#EXTINF:")) {
    return "media";
  }
  return "unsupported";
}

export function mediaLiveConfiguration(primaryBaseUrl: string, backupBaseUrl: string) {
  return {
    channelClass: "STANDARD",
    destinationAUrl: `${primaryBaseUrl}/index`,
    destinationBUrl: `${backupBaseUrl}/index`,
    cdnSettings: "HLS basic put",
    outputSelection: "Manifests and segments",
    directoryStructure: "Single directory",
    nameModifier: `-${DEMO_RENDITION}`,
    segmentModifier: "$dt$",
    segmentLengthSeconds: 2,
    indexNSegments: 30,
    keepSegments: 35,
    credentials: "None (token is embedded in the destination URL)",
    expectedMediaPlaylist: `index-${DEMO_RENDITION}.m3u8`,
  } as const;
}

async function ensureMasterPlaylist(env: Env): Promise<void> {
  const body = [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    "#EXT-X-INDEPENDENT-SEGMENTS",
    "#EXT-X-STREAM-INF:BANDWIDTH=900000,AVERAGE-BANDWIDTH=750000,RESOLUTION=640x360,CODECS=\"avc1.42e01e,mp4a.40.2\"",
    `current/${DEMO_RENDITION}/index.m3u8`,
    "",
  ].join("\n");
  await env.MEDIA.put(CANONICAL_MASTER_KEY, body, {
    httpMetadata: PLAYLIST_HTTP_METADATA,
  });
}

async function commitDecision(
  env: Env,
  stub: CoordinatorStub,
  decision: PublicationDecision,
): Promise<PublicationResult> {
  if (!decision.accepted) {
    return {
      published: false,
      reason: decision.reason,
      ...(decision.reason === "standby" || decision.reason === "already_active"
        ? { activeSource: decision.activeSource }
        : {}),
    };
  }
  const commit = await stub.commitPublicationToR2(
    decision.generation,
    decision.publicationId,
    decision.publication,
  );
  if (!commit.committed) {
    if (commit.reason === "transient") throw new RetryableIngestError("Canonical playlist storage temporarily failed");
    const messages = {
      inactive: "Publication is no longer active",
      canonical_changed: "Canonical playlist changed before publication commit",
      newer_canonical: "Canonical playlist is newer than this publication",
    } as const;
    throw new Error(messages[commit.reason]);
  }
  await ensureMasterPlaylist(env);
  return { published: true, reason: "committed", generation: decision.generation };
}

async function reconcilePublication(env: Env, stub: CoordinatorStub, manifestKey: string): Promise<"ready" | "in_progress"> {
  const state = await stub.getState();
  if (!state.pendingGeneration) return "ready";
  const current = await env.MEDIA.head(manifestKey);
  const generation = Number(current?.customMetadata?.generation);
  const result = await stub.recoverPublication(
    Number.isSafeInteger(generation) ? generation : undefined,
    current?.customMetadata?.publicationId,
    current?.etag,
  );
  return result === "in_progress" ? "in_progress" : "ready";
}

async function publishPlaylist(
  env: Env,
  stub: CoordinatorStub,
  target: IngestTarget,
  sourcePrefix: string,
  playlist: string,
): Promise<Record<string, unknown>> {
  const { source, eventId, rendition } = target;
  const manifestKey = `live/current/${rendition}/index.m3u8`;
  if (await reconcilePublication(env, stub, manifestKey) === "in_progress") {
    return { published: false, reason: "publication_in_progress", state: await stub.getState() };
  }
  const canonical = canonicalizeMediaPlaylist(playlist, sourcePrefix);
  await storeSourcePlaylist(env, stub, target, sourcePrefix, playlist);
  const publication: PublicationInput = {
    source,
    eventId,
    rendition,
    manifestKey,
    manifest: canonical.manifest,
    segmentNames: canonical.objectNames,
    mediaSequence: playlistMediaSequence(playlist),
  };
  const decision = await stub.preparePublication(publication);
  const result = await commitDecision(env, stub, decision);
  const missing = !decision.accepted && decision.reason === "missing_objects" ? decision.missing : undefined;
  return { ...result, missing, state: await stub.getState() };
}

async function storeSourcePlaylist(
  env: Env,
  stub: CoordinatorStub,
  target: IngestTarget,
  sourcePrefix: string,
  playlist: string,
): Promise<string> {
  const key = `${sourcePrefix}/${target.objectName}`;
  await env.MEDIA.put(key, playlist, {
    httpMetadata: PLAYLIST_HTTP_METADATA,
  });
  const recorded = await stub.recordObject({
    source: target.source,
    eventId: target.eventId,
    rendition: target.rendition,
    name: target.objectName,
    r2Key: key,
    kind: "playlist",
    size: textEncoder.encode(playlist).byteLength,
  });
  if (!recorded) {
    await env.MEDIA.delete(key);
    throw new Error("Ingest session ended before the playlist was recorded");
  }
  return key;
}

function recordSegment(
  stub: CoordinatorStub,
  target: IngestTarget,
  key: string,
  size: number,
): Promise<boolean> {
  return stub.recordObject({
    source: target.source,
    eventId: target.eventId,
    rendition: target.rendition,
    name: target.objectName,
    r2Key: key,
    kind: "segment",
    size,
  });
}

async function authorizeIngest(request: Request, env: Env, target: IngestTarget): Promise<boolean> {
  const expected = env.INGEST_SECRET;
  if (target.publishToken) {
    return verifyExternalPublisherToken(target.publishToken, expected, {
      source: target.tokenSource,
      eventId: target.eventId,
      rendition: target.rendition,
    });
  }
  const authorization = request.headers.get("Authorization") ?? "";
  const supplied = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  return Boolean(supplied && constantTimeEqual(supplied, expected));
}

export async function handleIngest(request: Request, env: Env): Promise<Response> {
  if (request.method !== "PUT") return json({ error: "method_not_allowed" }, 405, { Allow: "PUT" });
  const target = parseIngestTarget(new URL(request.url).pathname);
  if (!target) return json({ error: "invalid_ingest_path" }, 404);
  if (!(await authorizeIngest(request, env, target))) return json({ error: "invalid_ingest_credentials" }, 401);
  const stub = coordinator(env);
  if (!(await stub.acceptsIngest(target.eventId))) return json({ error: "stale_ingest_session" }, 409);

  const { source, eventId, rendition, objectName } = target;
  try {
    assertName(eventId, "event ID");
    assertName(rendition, "rendition");
    assertName(objectName, "object name");
    const sourcePrefix = `${LIVE_PREFIX}sources/${target.tokenSource}/${eventId}/${rendition}`;
    if (objectName.endsWith(".m3u8")) {
      const body = await readPlaylist(request);
      const playlistKind = rendition === DEMO_RENDITION ? classifyIngestPlaylist(objectName, body) : "unsupported";
      if (playlistKind === "unsupported") {
        return json({
          error: "unsupported_demo_playlist",
          expected: ["index.m3u8", `index-${DEMO_RENDITION}.m3u8`],
        }, 400);
      }
      if (playlistKind === "master") {
        const object = await storeSourcePlaylist(env, stub, target, sourcePrefix, body);
        return json({ ok: true, object, published: false, reason: "master_manifest_stored" }, 202);
      }
      const result = await publishPlaylist(env, stub, target, sourcePrefix, body);
      return json({ ok: true, object: `${sourcePrefix}/${objectName}`, ...result }, 202);
    }
    if (!request.body) return json({ error: "empty_object" }, 400);

    const key = `${sourcePrefix}/${objectName}`;
    const contentMd5Header = request.headers.get("Content-MD5");
    const suppliedMd5 = contentMd5(contentMd5Header);
    if (contentMd5Header && !suppliedMd5) return json({ error: "invalid_content_md5" }, 400);
    const verificationKey = `${sourcePrefix}/.verification-${crypto.randomUUID()}`;
    const verification = await env.MEDIA.put(verificationKey, request.body, {
      ...(suppliedMd5 ? { md5: suppliedMd5 } : {}),
    });
    try {
      let existing = await env.MEDIA.head(key);
      if (!existing) {
        const staged = await env.MEDIA.get(verificationKey);
        if (!staged) return json({ error: "stale_ingest_session" }, 409);
        const object = await env.MEDIA.put(key, staged.body, {
          onlyIf: { etagDoesNotMatch: "*" },
          httpMetadata: objectName.endsWith(".ts") ? SEGMENT_HTTP_METADATA : undefined,
          customMetadata: { source, eventId, rendition },
          ...(verification.checksums.md5 ? { md5: verification.checksums.md5 } : {}),
        });
        if (object) {
          if (!await recordSegment(stub, target, key, object.size)) {
            await env.MEDIA.delete(key);
            return json({ error: "stale_ingest_session" }, 409);
          }
          return json({ ok: true, object: key, etag: object.httpEtag }, 201);
        }
        existing = await env.MEDIA.head(key);
      }
      if (!existing) return json({ error: "object_commit_failed", object: key }, 503, { "Retry-After": "1" });
      const existingMetadata = existing.customMetadata;
      const existingSource = existingMetadata?.source;
      const sameTarget = (existingSource === source || (target.tokenSource === "live" && existingSource === "live"))
        && existingMetadata?.eventId === eventId
        && existingMetadata?.rendition === rendition;
      const sameSize = verification.size === existing.size;
      const sameChecksum = checksumsMatch(verification.checksums.md5, existing.checksums?.md5);
      if (!sameTarget || !sameSize || !sameChecksum) {
        return json({ error: "object_already_exists", object: key }, 409);
      }
      if (!await recordSegment(stub, target, key, existing.size)) {
        await env.MEDIA.delete(key);
        return json({ error: "stale_ingest_session" }, 409);
      }
      return json({ ok: true, object: key, etag: existing.httpEtag, duplicate: true }, 200);
    } finally {
      try {
        await env.MEDIA.delete(verificationKey);
      } catch {
        // The short-lived verification object remains under the volatile source prefix.
      }
    }
  } catch (error) {
    if (error instanceof RetryableIngestError) {
      return json({ error: "ingest_temporarily_unavailable", detail: error.message }, 503, { "Retry-After": "1" });
    }
    return json({ error: "invalid_ingest", detail: error instanceof Error ? error.message : String(error) }, 400);
  }
}

async function deletePrefix(bucket: R2Bucket, prefix: string): Promise<void> {
  let cursor: string | undefined;
  do {
    const listed = await bucket.list({ prefix, cursor, limit: 1000 });
    if (listed.objects.length) await bucket.delete(listed.objects.map((object) => object.key));
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
}

async function clearLiveState(env: Env, stub: CoordinatorStub): Promise<void> {
  await stub.deactivateIngest();
  await stopPublisherContainers(env);
  await Promise.all([
    deletePrefix(env.MEDIA, `${LIVE_PREFIX}current/`),
    deletePrefix(env.MEDIA, `${LIVE_PREFIX}sources/`),
  ]);
  await stub.reset();
}

async function startContainerInstance(
  env: Env,
  source: SourceRole,
  eventId: string,
  timeline: { startAtEpochSeconds: number; startNumber: number },
): Promise<void> {
  const ingestBaseUrl = new URL(
    `/ingest/${STREAM_ID}/${source}/${eventId}/${DEMO_RENDITION}`,
    "http://ingest.worker",
  ).toString().replace(/\/$/, "");
  await publisherContainer(env, source).startAndWaitForPorts({
    ports: 8080,
    startOptions: {
      enableInternet: false,
      envVars: {
        SOURCE: source,
        EVENT_ID: eventId,
        RENDITION: DEMO_RENDITION,
        INGEST_BASE_URL: ingestBaseUrl,
        HLS_START_NUMBER: String(timeline.startNumber),
        START_AT_EPOCH: String(timeline.startAtEpochSeconds),
      },
    },
    cancellationOptions: { portReadyTimeoutMS: 30_000 },
  });
}

async function startContainerPublishers(request: Request, env: Env, stub: CoordinatorStub): Promise<Response> {
  const input = await request.json().catch(() => ({})) as { source?: unknown };
  const requestedSource = typeof input.source === "string" && isSourceRole(input.source) ? input.source : undefined;
  if (input.source !== undefined && !requestedSource) {
    return json({ error: "invalid_source", expected: SOURCE_ROLES }, 400);
  }

  let eventId: string;
  if (requestedSource) {
    const state = await stub.getState();
    if (!state.ingestEventId) return json({ error: "no_active_container_event" }, 409);
    eventId = state.ingestEventId;
  } else {
    await clearLiveState(env, stub);
    eventId = publisherEventId("container");
    await stub.activateIngest(eventId);
  }

  const timeline = containerTimeline(eventId);
  if (!timeline) return json({ error: "not_a_managed_container_event" }, 409);
  const sources = requestedSource ? [requestedSource] : SOURCE_ROLES;
  try {
    await Promise.all(sources.map((source) => startContainerInstance(
      env,
      source,
      eventId,
      timeline,
    )));
  } catch (error) {
    await Promise.allSettled(sources.map((source) => stopPublisherContainers(env, source)));
    if (!requestedSource) await stub.deactivateIngest();
    throw error;
  }
  return json({ ok: true, eventId, sources, containers: await publisherContainerStatuses(env) }, 202);
}

async function createPublisherTarget(
  requestUrl: string,
  source: SourceRole,
  eventId: string,
  issuedAt: number,
  expiresAt: number,
  ingestSecret: string,
): Promise<PublisherTarget> {
  const token = await issueExternalPublisherToken({
    source,
    eventId,
    rendition: DEMO_RENDITION,
    iat: issuedAt,
    exp: expiresAt,
    nonce: crypto.randomUUID(),
  }, ingestSecret);
  const publishBaseUrl = new URL(
    `/publish/${STREAM_ID}/${source}/${eventId}/${DEMO_RENDITION}/${token}`,
    requestUrl,
  ).toString().replace(/\/$/, "");
  const ingestUrl = `${publishBaseUrl}/index.m3u8`;
  const segmentUrl = `${publishBaseUrl}/segment-%06d.ts`;
  return {
    source,
    publishBaseUrl,
    ingestUrl,
    ffmpegCommand: `ffmpeg -re -i INPUT -c:v libx264 -preset veryfast -vf scale=-2:360 -b:v 800k -maxrate 900k -bufsize 1600k -c:a aac -b:a 96k -ar 48000 -f hls -method PUT -hls_time 2 -hls_list_size 30 -hls_start_number_source epoch -hls_flags independent_segments+omit_endlist -hls_segment_filename '${segmentUrl}' '${ingestUrl}'`,
    dockerCommand: `docker build --platform linux/amd64 -t protected-hls-publisher ./container && docker run --rm --platform linux/amd64 --name protected-hls-${source}-publisher -v "\${SSL_CERT_FILE:-/etc/ssl/cert.pem}:/etc/ssl/certs/host-ca.pem:ro" -e SSL_CERT_FILE=/etc/ssl/certs/host-ca.pem -e SOURCE='${source}' -e INGEST_BASE_URL='${publishBaseUrl}' -e EVENT_ID='${eventId}' -e RENDITION='${DEMO_RENDITION}' protected-hls-publisher`,
    obs: {
      outputType: "Output to URL",
      containerFormat: "hls",
      url: ingestUrl,
      muxerSettings: `method=PUT hls_time=2 hls_list_size=30 hls_start_number_source=epoch hls_flags=independent_segments+omit_endlist hls_segment_filename=${segmentUrl}`,
    },
  };
}

async function issuePublisher(request: Request, env: Env, stub: CoordinatorStub): Promise<Response> {
  const input = await request.json().catch(() => ({})) as { publisher?: unknown };
  const isMediaLive = input.publisher === "medialive";
  const ingestSecret = env.INGEST_SECRET;
  await clearLiveState(env, stub);
  const eventId = publisherEventId(isMediaLive ? "medialive" : "external");
  await stub.activateIngest(eventId);
  const issuedAt = Math.floor(Date.now() / 1000);
  const ttlSeconds = isMediaLive ? MEDIALIVE_PUBLISH_TTL_SECONDS : EXTERNAL_PUBLISH_TTL_SECONDS;
  const expiresAt = issuedAt + ttlSeconds;
  const targets = await Promise.all(
    SOURCE_ROLES.map((source) => createPublisherTarget(request.url, source, eventId, issuedAt, expiresAt, ingestSecret)),
  );
  const sources = { primary: targets[0], backup: targets[1] };
  return json({
    protocol: "HLS over HTTPS PUT",
    eventId,
    rendition: DEMO_RENDITION,
    expiresAt: new Date(expiresAt * 1000).toISOString(),
    ttlSeconds,
    sources,
    mediaLive: mediaLiveConfiguration(sources.primary.publishBaseUrl, sources.backup.publishBaseUrl),
  });
}

async function switchSource(request: Request, env: Env, stub: CoordinatorStub): Promise<Response> {
  const input = await request.json().catch(() => ({})) as { source?: unknown };
  if (typeof input.source !== "string" || !isSourceRole(input.source)) {
    return json({ error: "invalid_source", expected: SOURCE_ROLES }, 400);
  }

  const manifestKey = `live/current/${DEMO_RENDITION}/index.m3u8`;
  if (await reconcilePublication(env, stub, manifestKey) === "in_progress") {
    return json({ error: "publication_in_progress" }, 409);
  }

  const decision = await stub.promoteSource(input.source);
  const result = await commitDecision(env, stub, decision);
  const state = await stub.getState();
  if (result.reason === "already_active") {
    return json({ ok: true, source: input.source, ...result, state });
  }
  return json({ ok: result.published, source: input.source, ...result, state }, result.published ? 200 : 409);
}

export async function handlePart2Api(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const stub = coordinator(env);
  try {
    if (url.pathname === "/api/part2/state" && request.method === "GET") {
      const files = await env.MEDIA.list({ prefix: LIVE_PREFIX, delimiter: undefined, limit: 200 });
      return json({ state: await stub.getState(), files: files.objects.map((object) => ({ key: object.key, size: object.size })) });
    }
    if (url.pathname === "/api/part2/container/status" && request.method === "GET") {
      return json(await publisherContainerStatuses(env));
    }
    if (url.pathname === "/api/part2/container/start" && request.method === "POST") {
      return await startContainerPublishers(request, env, stub);
    }
    if (url.pathname === "/api/part2/container/stop" && request.method === "POST") {
      const input = await request.json().catch(() => ({})) as { source?: unknown };
      const source = typeof input.source === "string" && isSourceRole(input.source) ? input.source : undefined;
      if (input.source !== undefined && !source) return json({ error: "invalid_source", expected: SOURCE_ROLES }, 400);
      await stopPublisherContainers(env, source);
      return json({ ok: true, containers: await publisherContainerStatuses(env) });
    }
    if (url.pathname === "/api/part2/publisher" && request.method === "POST") {
      return await issuePublisher(request, env, stub);
    }
    if (url.pathname === "/api/part2/failover" && request.method === "POST") {
      return await switchSource(request, env, stub);
    }
    if (url.pathname === "/api/part2/reset" && request.method === "POST") {
      await clearLiveState(env, stub);
      return json({ ok: true, state: await stub.getState() });
    }
    return json({ error: "not_found" }, 404);
  } catch (error) {
    return json({ error: "part2_operation_failed", detail: error instanceof Error ? error.message : String(error) }, 500);
  }
}
