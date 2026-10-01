import { rewritePlaylist, tailMediaPlaylist } from "./hls";
import { handleIngest, handlePart2Api } from "./part2";
import { signToken, TokenError, verifyToken, type TokenClaims } from "./token";

export { StreamCoordinator } from "./stream-coordinator";
export { LivePublisherContainer } from "./live-publisher-container";
export { ContainerProxy } from "@cloudflare/containers";

const MEDIA_POLICIES = {
  vod: { acl: "/media/demo/*", masterPath: "/media/demo/master.m3u8" },
  live: { acl: "/media/live/*", masterPath: "/media/live/master.m3u8" },
} as const;

const LIVE_LATENCY_WINDOWS: Record<string, number> = {
  "3": 8,
  "6": 12,
  "12": 20,
  "20": 30,
};

function json(value: unknown, status = 200, headers?: HeadersInit): Response {
  return Response.json(value, {
    status,
    headers: { "Cache-Control": "no-store", ...headers },
  });
}

function clientIp(request: Request): string | undefined {
  return request.headers.get("CF-Connecting-IP") ?? undefined;
}

function corsHeaders(request: Request): Headers {
  const headers = new Headers();
  headers.set("Access-Control-Allow-Origin", request.headers.get("Origin") ?? "*");
  headers.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Range, Content-Type, CMCD-Request, CMCD-Object, CMCD-Status, CMCD-Session");
  headers.set("Access-Control-Expose-Headers", "Content-Length, Content-Range, ETag, X-Demo-Auth, X-Demo-Cache, X-Demo-Session-Token, X-Demo-Source");
  headers.set("Vary", "Origin");
  return headers;
}

function parsePositiveInteger(value: string, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

async function issueAccessToken(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405, { Allow: "POST" });
  let input: { bindIp?: boolean; ttlSeconds?: number; resource?: keyof typeof MEDIA_POLICIES } = {};
  try {
    input = await request.json();
  } catch {
    // An empty body uses the safe demo defaults.
  }

  const policy = MEDIA_POLICIES[input.resource === "live" ? "live" : "vod"];
  const policyTtl = parsePositiveInteger(env.ACCESS_TOKEN_TTL_SECONDS, 300);
  const ttl = Math.min(Math.max(Number(input.ttlSeconds) || policyTtl, 30), policyTtl);
  const now = Math.floor(Date.now() / 1000);
  const claims: TokenClaims = {
    st: now - 5,
    exp: now + ttl,
    acl: policy.acl,
    id: crypto.randomUUID(),
  };
  const ip = clientIp(request);
  if (input.bindIp && ip) claims.ip = ip;
  const token = await signToken(claims, env.ACCESS_PRIMARY_SECRET);
  const signedUrl = new URL(policy.masterPath, request.url);
  signedUrl.searchParams.set("hdnts", token);

  return json({
    tokenType: "hdnts",
    token,
    signedUrl: signedUrl.toString(),
    claims,
  });
}

function mediaPolicy(pathname: string): (typeof MEDIA_POLICIES)[keyof typeof MEDIA_POLICIES] {
  if (pathname.startsWith("/media/demo/")) return MEDIA_POLICIES.vod;
  if (pathname.startsWith("/media/live/")) return MEDIA_POLICIES.live;
  throw new TokenError("acl_policy", "The media path is outside the configured delivery policies");
}

async function authorizeMedia(
  request: Request,
  env: Env,
): Promise<{ sessionToken: string; mode: "hdnts->hdntl" | "hdntl" }> {
  const url = new URL(request.url);
  const policy = mediaPolicy(url.pathname);
  const accessTokens = url.searchParams.getAll("hdnts");
  const sessionTokens = url.searchParams.getAll("hdntl");
  const legacyTokens = url.searchParams.getAll("hdnea");
  if (accessTokens.length > 1 || sessionTokens.length > 1 || legacyTokens.length || (accessTokens.length && sessionTokens.length)) {
    throw new TokenError("location", "Duplicate or conflicting authorization tokens");
  }

  const now = Math.floor(Date.now() / 1000);
  const ip = clientIp(request);
  const maxSessionTtl = parsePositiveInteger(env.MAX_SESSION_TTL_SECONDS, 86400);

  if (accessTokens[0]) {
    const { ACCESS_PRIMARY_SECRET: primaryKey, ACCESS_TRANSITION_SECRET: transitionKey, SESSION_SECRET: sessionKey } = env;
    const accessTtl = parsePositiveInteger(env.ACCESS_TOKEN_TTL_SECONDS, 300);
    const access = await verifyToken(accessTokens[0], [primaryKey, transitionKey], {
      path: url.pathname,
      ip,
      maxLifetimeSeconds: Math.max(accessTtl * 2, 600),
    });
    if (access.acl !== policy.acl) throw new TokenError("acl_policy", "Token ACL does not match the configured media policy");
    const sessionTtl = Math.min(parsePositiveInteger(env.SESSION_TOKEN_TTL_SECONDS, 3600), maxSessionTtl);
    const claims: TokenClaims = {
      st: now - 5,
      exp: now + sessionTtl,
      acl: policy.acl,
      id: access.id,
      ip: access.ip,
    };
    return { sessionToken: await signToken(claims, sessionKey), mode: "hdnts->hdntl" };
  }

  if (sessionTokens[0]) {
    const session = await verifyToken(sessionTokens[0], [env.SESSION_SECRET], {
      path: url.pathname,
      ip,
      maxLifetimeSeconds: maxSessionTtl,
    });
    if (session.acl !== policy.acl) throw new TokenError("acl_policy", "Token ACL does not match the configured media policy");
    return { sessionToken: sessionTokens[0], mode: "hdntl" };
  }

  throw new TokenError("missing", "A valid hdnts or hdntl token is required");
}

async function sourceTree(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405, { Allow: "GET" });
  const objects = await env.MEDIA.list({ prefix: "demo/", limit: 200, include: ["httpMetadata", "customMetadata"] });
  return json({
    prefix: "demo/",
    objects: objects.objects.map((object) => ({
      key: object.key,
      size: object.size,
      etag: object.httpEtag,
      uploaded: object.uploaded.toISOString(),
      contentType: object.httpMetadata?.contentType,
    })),
  });
}

async function sourceFile(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405, { Allow: "GET" });
  const key = new URL(request.url).searchParams.get("key") ?? "";
  if (!key.startsWith("demo/") || !key.endsWith(".m3u8") || key.includes("..") || key.includes("\\")) {
    return json({ error: "invalid_source_key" }, 400);
  }
  const object = await env.MEDIA.get(key);
  if (!object) return json({ error: "not_found" }, 404);
  if (object.size > 1_000_000) return json({ error: "source_too_large" }, 413);
  return json({ key, size: object.size, etag: object.httpEtag, content: await object.text() });
}

function mediaKey(pathname: string): string {
  if (!pathname.startsWith("/media/") || pathname.includes("\\")) throw new Error("Invalid media path");
  return pathname.slice("/media/".length);
}

function objectHeaders(object: R2Object): Headers {
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("ETag", object.httpEtag);
  headers.set("Content-Length", String(object.size));
  headers.set("X-Demo-Source", "R2");
  return headers;
}

async function serveR2Object(request: Request, env: Env, ctx: ExecutionContext, key: string, playlist: boolean): Promise<Response> {
  const range = request.headers.get("Range");
  const cacheUrl = new URL(`/__r2-cache/${key}`, request.url);
  const cacheKey = new Request(cacheUrl, { method: "GET" });
  const edgeCache = (caches as CacheStorage & { default: Cache }).default;
  const sharedCacheEligible = request.method === "GET" && !range && !playlist;

  if (sharedCacheEligible) {
    const cached = await edgeCache.match(cacheKey);
    if (cached) {
      const response = new Response(cached.body, cached);
      response.headers.set("X-Demo-Cache", "HIT");
      return response;
    }
  }

  if (request.method === "HEAD") {
    const object = await env.MEDIA.head(key);
    if (!object) return new Response("Not found", { status: 404 });
    const headers = objectHeaders(object);
    headers.set("X-Demo-Cache", "BYPASS");
    return new Response(null, { headers });
  }

  const object = await env.MEDIA.get(key, range ? { range: request.headers } : undefined);
  if (!object) return new Response("Not found", { status: 404 });

  const headers = objectHeaders(object);
  headers.set("Accept-Ranges", "bytes");
  headers.set("X-Demo-Cache", range ? "BYPASS" : "MISS");
  headers.set("Cache-Control", playlist ? "no-store" : "public, max-age=31536000, immutable");

  let status = 200;
  if (range && object.range && "offset" in object.range) {
    const offset = object.range.offset;
    const length = object.range.length;
    if (typeof offset === "number" && typeof length === "number") {
      status = 206;
      headers.set("Content-Range", `bytes ${offset}-${offset + length - 1}/${object.size}`);
      headers.set("Content-Length", String(length));
    }
  }

  const response = new Response(object.body, { status, headers });
  if (sharedCacheEligible && status === 200) ctx.waitUntil(edgeCache.put(cacheKey, response.clone()));
  return response;
}

async function serveMedia(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
    return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD, OPTIONS" } });
  }
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(request) });

  const url = new URL(request.url);
  const playlist = url.pathname.endsWith(".m3u8");
  if (playlist && request.headers.has("Range")) {
    return new Response("Range requests are not supported for playlists", { status: 416, headers: corsHeaders(request) });
  }
  try {
    const authorization = await authorizeMedia(request, env);
    const upstream = await serveR2Object(request, env, ctx, mediaKey(url.pathname), playlist);
    const headers = new Headers(upstream.headers);
    for (const [name, value] of corsHeaders(request)) headers.set(name, value);
    headers.set("X-Demo-Auth", authorization.mode);

    if (!playlist || request.method === "HEAD" || !upstream.ok) {
      console.log(JSON.stringify({ event: "delivery", path: url.pathname, outcome: upstream.status, auth: authorization.mode }));
      return new Response(upstream.body, { status: upstream.status, headers });
    }

    const playlistSize = Number(headers.get("Content-Length"));
    if (!Number.isFinite(playlistSize) || playlistSize > 1_000_000) {
      throw new Error("Playlist exceeds the 1 MB delivery limit");
    }

    const canonical = await upstream.text();
    const segmentWindow = url.pathname === "/media/live/current/360p/index.m3u8"
      ? LIVE_LATENCY_WINDOWS[url.searchParams.get("latency") ?? "12"] ?? LIVE_LATENCY_WINDOWS["12"]
      : undefined;
    const served = segmentWindow ? tailMediaPlaylist(canonical, segmentWindow) : canonical;
    const rewritten = rewritePlaylist(served, url, authorization.sessionToken);
    headers.set("Content-Type", "application/vnd.apple.mpegurl; charset=utf-8");
    headers.set("Cache-Control", "private, no-store");
    headers.delete("Content-Length");
    headers.set("X-Demo-Session-Token", authorization.sessionToken);
    console.log(JSON.stringify({ event: "delivery", path: url.pathname, outcome: 200, auth: authorization.mode, rewritten: true }));
    return new Response(rewritten, { status: 200, headers });
  } catch (error) {
    const code = error instanceof TokenError ? error.code : "delivery_error";
    const status = error instanceof TokenError ? 401 : 502;
    console.log(JSON.stringify({ event: "delivery", path: url.pathname, outcome: status, reason: code }));
    const headers = corsHeaders(request);
    headers.set("Cache-Control", "no-store");
    return new Response(error instanceof Error ? error.message : "Delivery failed", { status, headers });
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/") return Response.redirect(new URL("/part-1/", url), 302);
    if (url.pathname === "/api/health") {
      const media = await env.MEDIA.head("demo/master.m3u8");
      return json({ status: "ok", worker: "edge", media: media ? "ready" : "missing", secrets: "ready" });
    }
    if (url.pathname === "/api/token") return issueAccessToken(request, env);
    if (url.pathname === "/api/source/tree") return sourceTree(request, env);
    if (url.pathname === "/api/source/file") return sourceFile(request, env);
    if (url.pathname.startsWith("/api/part2/")) return handlePart2Api(request, env);
    if (url.pathname.startsWith("/ingest/") || url.pathname.startsWith("/publish/")) return handleIngest(request, env);
    if (url.pathname.startsWith("/media/")) return serveMedia(request, env, ctx);
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
