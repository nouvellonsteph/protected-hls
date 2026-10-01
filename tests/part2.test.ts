import { describe, expect, it } from "vitest";
import {
  classifyIngestPlaylist,
  handleIngest,
  handlePart2Api,
  issueExternalPublisherToken,
  mediaLiveConfiguration,
  verifyExternalPublisherToken,
  type ExternalPublisherClaims,
} from "../src/part2";
import { isSourceRole, sourcePublicationMode } from "../src/source-role";

const secret = "external-publisher-test-secret";
const claims: ExternalPublisherClaims = {
  source: "primary",
  eventId: "external-demo",
  rendition: "360p",
  iat: 1_000,
  exp: 1_900,
  nonce: "test-nonce",
};

describe("external publisher tokens", () => {
  it("issues a URL-path-safe token scoped to one publisher", async () => {
    const token = await issueExternalPublisherToken(claims, secret);
    const backupClaims = { ...claims, source: "backup" as const, nonce: "backup-nonce" };
    const backupToken = await issueExternalPublisherToken(backupClaims, secret);

    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(backupToken).not.toBe(token);
    await expect(verifyExternalPublisherToken(token, secret, claims, 1_500)).resolves.toBe(true);
    await expect(verifyExternalPublisherToken(backupToken, secret, backupClaims, 1_500)).resolves.toBe(true);
    await expect(verifyExternalPublisherToken(token, secret, { ...claims, eventId: "another-event" }, 1_500)).resolves.toBe(false);
    await expect(verifyExternalPublisherToken(token, secret, { ...claims, source: "backup" }, 1_500)).resolves.toBe(false);
  });

  it("rejects expired and modified tokens", async () => {
    const token = await issueExternalPublisherToken(claims, secret);
    const modified = `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`;

    await expect(verifyExternalPublisherToken(token, secret, claims, 1_901)).resolves.toBe(false);
    await expect(verifyExternalPublisherToken(modified, secret, claims, 1_500)).resolves.toBe(false);
  });

  it("accepts a still-valid legacy live-source token during migration", async () => {
    const legacyClaims = { ...claims, source: "live" } as unknown as ExternalPublisherClaims;
    const token = await issueExternalPublisherToken(legacyClaims, secret);

    await expect(verifyExternalPublisherToken(token, secret, {
      source: "live",
      eventId: claims.eventId,
      rendition: claims.rendition,
    }, 1_500)).resolves.toBe(true);
  });

  it("allows a six-hour MediaLive session but rejects a longer token", async () => {
    const sixHours = { ...claims, exp: claims.iat + 6 * 60 * 60 };
    const tooLong = { ...claims, exp: claims.iat + 6 * 60 * 60 + 1 };

    await expect(verifyExternalPublisherToken(await issueExternalPublisherToken(sixHours, secret), secret, sixHours, 1_500)).resolves.toBe(true);
    await expect(verifyExternalPublisherToken(await issueExternalPublisherToken(tooLong, secret), secret, tooLong, 1_500)).resolves.toBe(false);
  });
});

describe("AWS MediaLive ingest", () => {
  it("distinguishes the MediaLive master manifest from its rendition manifest", () => {
    const master = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nindex-360p.m3u8\n";
    const media = "#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2.0,\nindex-360p_00001.ts\n";

    expect(classifyIngestPlaylist("index.m3u8", master)).toBe("master");
    expect(classifyIngestPlaylist("index-360p.m3u8", media)).toBe("media");
    expect(classifyIngestPlaylist("index-720p.m3u8", media)).toBe("unsupported");
  });

  it("generates the base filename URL expected by an HLS Basic PUT output group", () => {
    const config = mediaLiveConfiguration(
      "https://example.com/publish/primary-token",
      "https://example.com/publish/backup-token",
    );

    expect(config.channelClass).toBe("STANDARD");
    expect(config.destinationAUrl).toBe("https://example.com/publish/primary-token/index");
    expect(config.destinationBUrl).toBe("https://example.com/publish/backup-token/index");
    expect(config.nameModifier).toBe("-360p");
    expect(config.segmentModifier).toBe("$dt$");
    expect(config.expectedMediaPlaylist).toBe("index-360p.m3u8");
  });
});

describe("primary and backup arbitration", () => {
  it("publishes primary by default and keeps backup ready as standby", () => {
    expect(sourcePublicationMode(null, "primary")).toBe("publish");
    expect(sourcePublicationMode(null, "backup")).toBe("standby");
    expect(sourcePublicationMode("primary", "primary")).toBe("publish");
    expect(sourcePublicationMode("primary", "backup")).toBe("standby");
    expect(sourcePublicationMode("backup", "backup")).toBe("publish");
    expect(sourcePublicationMode("backup", "primary")).toBe("standby");
  });

  it("accepts only explicit source roles", () => {
    expect(isSourceRole("primary")).toBe(true);
    expect(isSourceRole("backup")).toBe(true);
    expect(isSourceRole("live")).toBe(false);
  });

  it("promotes backup through the canonical generation without changing its viewer path", async () => {
    let activeSource = "primary";
    let generation = 7;
    const writes: Array<{ key: string; options?: R2PutOptions }> = [];
    const stub = {
      getState: async () => ({ pendingGeneration: null, activeSource, generation }),
      promoteSource: async () => ({
        accepted: true as const,
        reason: "ready" as const,
        generation: 8,
        publicationId: "promotion-8",
        previousEtag: "previous-etag",
        publication: {
          source: "backup" as const,
          eventId: "event-1",
          rendition: "360p",
          manifestKey: "live/current/360p/index.m3u8",
          manifest: "#EXTM3U\n/media/live/sources/backup/event-1/360p/segment-1.ts\n",
          segmentNames: ["segment-1.ts"],
        },
      }),
      commitPublicationToR2: async () => {
        activeSource = "backup";
        generation = 8;
        return { committed: true as const, etag: "backup-etag" };
      },
    };
    const namespace = Object.assign({} as Env["STREAM_COORDINATOR"], {
      idFromName: () => ({}),
      get: () => stub,
    });
    const bucket = Object.assign({} as R2Bucket, {
      put: async (key: string, _value: unknown, options?: R2PutOptions) => {
        writes.push({ key, options });
        return { etag: "backup-etag" };
      },
    });
    const env = Object.assign({} as Env, { STREAM_COORDINATOR: namespace, MEDIA: bucket });

    const response = await handlePart2Api(new Request("https://example.com/api/part2/failover", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: "backup" }),
    }), env);
    const body = await response.json() as { ok: boolean; source: string; generation: number; state: { activeSource: string } };

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ ok: true, source: "backup", generation: 8, state: { activeSource: "backup" } });
    expect(writes.map((write) => write.key)).toEqual(["live/master.m3u8"]);
  });

  it("delegates canonical publication to the coordinator before updating the master", async () => {
    const writes: Array<{ key: string; options?: R2PutOptions }> = [];
    const stub = {
      getState: async () => ({ pendingGeneration: null, activeSource: "primary", generation: 3 }),
      promoteSource: async () => ({
        accepted: true as const,
        reason: "ready" as const,
        generation: 4,
        publicationId: "promotion-4",
        previousEtag: undefined,
        publication: {
          source: "backup" as const,
          eventId: "event-1",
          rendition: "360p",
          manifestKey: "live/current/360p/index.m3u8",
          manifest: "#EXTM3U\n/media/live/sources/backup/event-1/360p/segment-1.ts\n",
          segmentNames: ["segment-1.ts"],
        },
      }),
      commitPublicationToR2: async () => ({ committed: true as const, etag: "backup-etag" }),
    };
    const namespace = Object.assign({} as Env["STREAM_COORDINATOR"], {
      idFromName: () => ({}),
      get: () => stub,
    });
    const bucket = Object.assign({} as R2Bucket, {
      put: async (key: string, _value: unknown, options?: R2PutOptions) => {
        writes.push({ key, options });
        return { etag: "master-etag" };
      },
    });
    const env = Object.assign({} as Env, { STREAM_COORDINATOR: namespace, MEDIA: bucket });

    const response = await handlePart2Api(new Request("https://example.com/api/part2/failover", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: "backup" }),
    }), env);

    expect(response.status).toBe(200);
    expect(writes.map((write) => write.key)).toEqual(["live/master.m3u8"]);
  });

  it("does not publish after the coordinator deactivates the event", async () => {
    let writes = 0;
    const stub = {
      getState: async () => ({ pendingGeneration: null }),
      promoteSource: async () => ({
        accepted: true as const,
        reason: "ready" as const,
        generation: 4,
        publicationId: "promotion-4",
        previousEtag: undefined,
        publication: {
          source: "backup" as const,
          eventId: "event-1",
          rendition: "360p",
          manifestKey: "live/current/360p/index.m3u8",
          manifest: "#EXTM3U\n/media/live/sources/backup/event-1/360p/segment-1.ts\n",
          segmentNames: ["segment-1.ts"],
        },
      }),
      commitPublicationToR2: async () => ({ committed: false as const, reason: "inactive" as const }),
    };
    const namespace = Object.assign({} as Env["STREAM_COORDINATOR"], {
      idFromName: () => ({}),
      get: () => stub,
    });
    const bucket = Object.assign({} as R2Bucket, {
      put: async () => {
        writes += 1;
        return { etag: "unexpected" };
      },
    });
    const env = Object.assign({} as Env, { STREAM_COORDINATOR: namespace, MEDIA: bucket });

    const response = await handlePart2Api(new Request("https://example.com/api/part2/failover", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: "backup" }),
    }), env);
    const body = await response.json() as { detail: string };

    expect(response.status).toBe(500);
    expect(body.detail).toBe("Publication is no longer active");
    expect(writes).toBe(0);
  });
});

describe("reset fencing", () => {
  it("deactivates ingest before clearing R2 and resetting the coordinator", async () => {
    const calls: string[] = [];
    const prefixes: string[] = [];
    const stub = {
      deactivateIngest: async () => calls.push("deactivate"),
      reset: async () => calls.push("reset"),
      getState: async () => ({}),
    };
    const namespace = Object.assign({} as Env["STREAM_COORDINATOR"], {
      idFromName: () => ({}),
      get: () => stub,
    });
    const media = Object.assign({} as R2Bucket, {
      list: async ({ prefix }: R2ListOptions) => {
        calls.push("list");
        prefixes.push(prefix ?? "");
        return { objects: [], truncated: false };
      },
    });
    const container = {
      getState: async () => {
        calls.push("container");
        return { status: "stopped", lastChange: 0 };
      },
    };
    const livePublisher = Object.assign({} as Env["LIVE_PUBLISHER"], { getByName: () => container });
    const env = Object.assign({} as Env, {
      STREAM_COORDINATOR: namespace,
      LIVE_PUBLISHER: livePublisher,
      MEDIA: media,
    });

    const response = await handlePart2Api(new Request("https://example.com/api/part2/reset", { method: "POST" }), env);

    expect(response.status).toBe(200);
    expect(calls).toEqual(["deactivate", "container", "container", "container", "list", "list", "reset"]);
    expect(prefixes.sort()).toEqual(["live/current/", "live/sources/"]);
  });
});

describe("managed publisher containers", () => {
  it("starts primary and backup on one aligned event timeline", async () => {
    const starts: Array<{ name: string; envVars: Record<string, string> }> = [];
    const states = new Map<string, string>();
    const containers = new Map<string, Record<string, unknown>>();
    let activeEvent = "";
    const containerFor = (name: string) => {
      const existing = containers.get(name);
      if (existing) return existing;
      const container = {
        getState: async () => ({ status: states.get(name) ?? "stopped", lastChange: 0 }),
        destroy: async () => { states.set(name, "stopped"); },
        startAndWaitForPorts: async (options: { startOptions: { envVars: Record<string, string> } }) => {
          starts.push({ name, envVars: options.startOptions.envVars });
          states.set(name, "healthy");
        },
        containerFetch: async () => Response.json({ ready: true }),
      };
      containers.set(name, container);
      return container;
    };
    const stub = {
      deactivateIngest: async () => undefined,
      activateIngest: async (eventId: string) => { activeEvent = eventId; },
      getState: async () => ({ ingestEventId: activeEvent }),
      reset: async () => undefined,
    };
    const namespace = Object.assign({} as Env["STREAM_COORDINATOR"], {
      idFromName: () => ({}),
      get: () => stub,
    });
    const livePublisher = Object.assign({} as Env["LIVE_PUBLISHER"], { getByName: containerFor });
    const media = Object.assign({} as R2Bucket, {
      list: async () => ({ objects: [], truncated: false }),
    });
    const env = Object.assign({} as Env, {
      STREAM_COORDINATOR: namespace,
      LIVE_PUBLISHER: livePublisher,
      MEDIA: media,
    });

    const response = await handlePart2Api(new Request("https://example.com/api/part2/container/start", {
      method: "POST",
    }), env);
    const body = await response.json() as { eventId: string; sources: string[] };

    expect(response.status).toBe(202);
    expect(body.sources).toEqual(["primary", "backup"]);
    expect(starts.map((start) => start.name)).toEqual(["live-demo-primary", "live-demo-backup"]);
    expect(starts.map((start) => start.envVars.SOURCE)).toEqual(["primary", "backup"]);
    expect(new Set(starts.map((start) => start.envVars.EVENT_ID))).toEqual(new Set([body.eventId]));
    expect(new Set(starts.map((start) => start.envVars.HLS_START_NUMBER)).size).toBe(1);
    expect(new Set(starts.map((start) => start.envVars.START_AT_EPOCH)).size).toBe(1);

    states.set("live-demo-primary", "stopped");
    const restart = await handlePart2Api(new Request("https://example.com/api/part2/container/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: "primary" }),
    }), env);

    expect(restart.status).toBe(202);
    expect(starts[2].envVars.EVENT_ID).toBe(body.eventId);
    expect(starts[2].envVars.HLS_START_NUMBER).toBe(starts[0].envVars.HLS_START_NUMBER);
    expect(starts[2].envVars.START_AT_EPOCH).toBe(starts[0].envVars.START_AT_EPOCH);
  });

  it("does not attach a managed container to an external publisher event", async () => {
    const stub = { getState: async () => ({ ingestEventId: "external-event-1" }) };
    const namespace = Object.assign({} as Env["STREAM_COORDINATOR"], {
      idFromName: () => ({}),
      get: () => stub,
    });
    const env = Object.assign({} as Env, { STREAM_COORDINATOR: namespace });

    const response = await handlePart2Api(new Request("https://example.com/api/part2/container/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: "backup" }),
    }), env);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "not_a_managed_container_event" });
  });
});

describe("ingest hardening", () => {
  function ingestEnv(stub: Record<string, unknown>, bucket: R2Bucket): Env {
    const namespace = Object.assign({} as Env["STREAM_COORDINATOR"], {
      idFromName: () => ({}),
      get: () => stub,
    });
    return Object.assign({} as Env, {
      STREAM_COORDINATOR: namespace,
      MEDIA: bucket,
      INGEST_SECRET: secret,
    });
  }

  it("treats a verified duplicate segment retry as idempotent", async () => {
    let verificationUpload = false;
    const stub = { acceptsIngest: async () => true, recordObject: async () => true };
    const bucket = Object.assign({} as R2Bucket, {
      put: async (key: string) => {
        verificationUpload = key.includes("/.verification-");
        return { etag: "verification-etag", size: 7, checksums: { md5: new Uint8Array(16).buffer } };
      },
      delete: async () => undefined,
      head: async () => ({
        size: 7,
        httpEtag: '"segment-etag"',
        checksums: { md5: new Uint8Array(16).buffer },
        customMetadata: {
          source: "primary",
          eventId: "event-1",
          rendition: "360p",
        },
      }),
    });
    const request = new Request("https://example.com/ingest/live-demo/primary/event-1/360p/segment-1.ts", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Length": "7",
        "Content-MD5": "AAAAAAAAAAAAAAAAAAAAAA==",
      },
      body: "segment",
    });

    const response = await handleIngest(request, ingestEnv(stub, bucket));

    expect(response.status).toBe(200);
    expect(verificationUpload).toBe(true);
    await expect(response.json()).resolves.toMatchObject({ ok: true, duplicate: true });
  });

  it("normalizes legacy live-source metadata for duplicate retries", async () => {
    const stub = { acceptsIngest: async () => true, recordObject: async () => true };
    const bucket = Object.assign({} as R2Bucket, {
      put: async () => ({
        etag: "verification-etag",
        size: 7,
        checksums: { md5: new Uint8Array(16).buffer },
      }),
      delete: async () => undefined,
      head: async () => ({
        size: 7,
        httpEtag: '"segment-etag"',
        checksums: { md5: new Uint8Array(16).buffer },
        customMetadata: {
          source: "live",
          eventId: "event-1",
          rendition: "360p",
        },
      }),
    });
    const request = new Request("https://example.com/ingest/live-demo/live/event-1/360p/segment-1.ts", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Length": "7",
        "Content-MD5": "AAAAAAAAAAAAAAAAAAAAAA==",
      },
      body: "segment",
    });

    const response = await handleIngest(request, ingestEnv(stub, bucket));

    expect(response.status).toBe(200);
  });

  it("verifies the winner when concurrent first uploads collide", async () => {
    const checksum = new Uint8Array(16).buffer;
    let headCalls = 0;
    const stub = { acceptsIngest: async () => true, recordObject: async () => true };
    const bucket = Object.assign({} as R2Bucket, {
      put: async (key: string) => key.includes("/.verification-")
        ? { etag: "verification-etag", size: 7, checksums: { md5: checksum } }
        : null,
      get: async () => ({ body: new Response("segment").body }),
      head: async () => {
        headCalls += 1;
        return headCalls === 1 ? null : {
          size: 7,
          httpEtag: '"winner-etag"',
          checksums: { md5: checksum },
          customMetadata: { source: "primary", eventId: "event-1", rendition: "360p" },
        };
      },
      delete: async () => undefined,
    });
    const request = new Request("https://example.com/ingest/live-demo/primary/event-1/360p/segment-1.ts", {
      method: "PUT",
      headers: { Authorization: `Bearer ${secret}` },
      body: "segment",
    });

    const response = await handleIngest(request, ingestEnv(stub, bucket));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ duplicate: true, etag: '"winner-etag"' });
  });

  it("rejects an unverified segment-key collision", async () => {
    const stub = { acceptsIngest: async () => true };
    const bucket = Object.assign({} as R2Bucket, {
      put: async () => ({
        etag: "verification-etag",
        size: 7,
        checksums: { md5: new Uint8Array(16).buffer },
      }),
      delete: async () => undefined,
      head: async () => ({
        size: 7,
        customMetadata: { source: "primary", eventId: "event-1", rendition: "360p" },
      }),
    });
    const request = new Request("https://example.com/ingest/live-demo/primary/event-1/360p/segment-1.ts", {
      method: "PUT",
      headers: { Authorization: `Bearer ${secret}` },
      body: "changed",
    });

    const response = await handleIngest(request, ingestEnv(stub, bucket));

    expect(response.status).toBe(409);
  });

  it("rejects an oversized chunked playlist while streaming it", async () => {
    const stub = { acceptsIngest: async () => true };
    const bucket = Object.assign({} as R2Bucket, {});
    const request = new Request("https://example.com/ingest/live-demo/primary/event-1/360p/index.m3u8", {
      method: "PUT",
      headers: { Authorization: `Bearer ${secret}` },
      body: `#EXTM3U\n${"x".repeat(1_000_000)}`,
    });

    const response = await handleIngest(request, ingestEnv(stub, bucket));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ detail: "Playlist exceeds 1 MB" });
  });

  it("returns a retryable response when canonical R2 storage is transiently unavailable", async () => {
    const stub = {
      acceptsIngest: async () => true,
      getState: async () => ({ pendingGeneration: null }),
      recordObject: async () => true,
      preparePublication: async () => ({
        accepted: true as const,
        reason: "ready" as const,
        generation: 1,
        publicationId: "publication-1",
        publication: {
          source: "primary" as const,
          eventId: "event-1",
          rendition: "360p",
          manifestKey: "live/current/360p/index.m3u8",
          manifest: "#EXTM3U\n/media/live/sources/primary/event-1/360p/segment-1.ts\n",
          segmentNames: ["segment-1.ts"],
          mediaSequence: 1,
        },
      }),
      commitPublicationToR2: async () => ({ committed: false as const, reason: "transient" as const }),
    };
    const bucket = Object.assign({} as R2Bucket, { put: async () => ({ etag: "source-playlist" }) });
    const request = new Request("https://example.com/ingest/live-demo/primary/event-1/360p/index.m3u8", {
      method: "PUT",
      headers: { Authorization: `Bearer ${secret}` },
      body: "#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:1\n#EXTINF:2,\nsegment-1.ts\n",
    });

    const response = await handleIngest(request, ingestEnv(stub, bucket));

    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("1");
  });
});
