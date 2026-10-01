import { DurableObject } from "cloudflare:workers";
import { isSourceRole, sourcePublicationMode, type SourceRole } from "./source-role";

export type { SourceRole } from "./source-role";

const SOURCE_FRESHNESS_MS = 10_000;

export type PublicationCommitResult =
  | { committed: true; etag: string }
  | { committed: false; reason: "inactive" | "canonical_changed" | "newer_canonical" | "transient" };

export interface RecordedObject {
  source: SourceRole;
  eventId: string;
  rendition: string;
  name: string;
  r2Key: string;
  kind: "segment" | "playlist";
  size: number;
}

export interface PublicationInput {
  source: SourceRole;
  eventId: string;
  rendition: string;
  manifestKey: string;
  manifest: string;
  segmentNames: string[];
  mediaSequence: number;
}

export type PublicationDecision =
  | {
      accepted: false;
      reason: "missing_objects";
      missing: string[];
    }
  | {
      accepted: false;
      reason: "publication_in_progress";
    }
  | {
      accepted: false;
      reason: "standby";
      activeSource: SourceRole | null;
    }
  | {
      accepted: false;
      reason: "source_not_ready" | "stale_event" | "sequence_regression";
    }
  | {
      accepted: false;
      reason: "already_active";
      activeSource: SourceRole;
    }
  | {
      accepted: true;
      reason: "ready";
      generation: number;
      publicationId: string;
      previousEtag?: string;
      publication: PublicationInput;
    };

interface StateRow extends Record<string, SqlStorageValue> {
  ingest_event: string | null;
  active_source: SourceRole | null;
  generation: number;
  published_source: SourceRole | null;
  published_event: string | null;
  published_rendition: string | null;
  manifest_key: string | null;
  etag: string | null;
  pending_generation: number | null;
  pending_source: SourceRole | null;
  pending_event: string | null;
  pending_rendition: string | null;
  pending_manifest_key: string | null;
  pending_id: string | null;
  pending_started_at: number | null;
  source_last_seen: number | null;
  updated_at: number;
}

interface LatestManifestRow extends Record<string, SqlStorageValue> {
  source: SourceRole;
  event_id: string;
  rendition: string;
  manifest_key: string;
  body: string;
  segment_names: string;
  updated_at: number;
}

interface LatestManifestStateRow extends Record<string, SqlStorageValue> {
  source: SourceRole;
  event_id: string;
  rendition: string;
  updated_at: number;
}

function mediaSequence(manifest: string): number {
  const value = Number(/^#EXT-X-MEDIA-SEQUENCE:(\d+)$/m.exec(manifest)?.[1] ?? 0);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

export interface SourceState {
  ready: boolean;
  eventId: string | null;
  rendition: string | null;
  updatedAt: number | null;
}

export interface CoordinatorState {
  activeSource: SourceRole | null;
  ingestEventId: string | null;
  generation: number;
  publishedSource: SourceRole | null;
  eventId: string | null;
  rendition: string | null;
  manifestKey: string | null;
  publishedEtag: string | null;
  pendingGeneration: number | null;
  pendingPublicationId: string | null;
  pendingStartedAt: number | null;
  lastSeen: number | null;
  objectCount: number;
  sources: Record<SourceRole, SourceState>;
  timeline: Array<{ id: number; kind: string; source: string | null; detail: string; created_at: number }>;
  updatedAt: number;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS stream_state (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    ingest_event TEXT,
    active_source TEXT,
    generation INTEGER NOT NULL DEFAULT 0,
    published_source TEXT,
    published_event TEXT,
    published_rendition TEXT,
    manifest_key TEXT,
    etag TEXT,
    pending_generation INTEGER,
    pending_source TEXT,
    pending_event TEXT,
    pending_rendition TEXT,
    pending_manifest_key TEXT,
    pending_id TEXT,
    pending_started_at INTEGER,
    source_last_seen INTEGER,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS objects (
    source TEXT NOT NULL,
    event_id TEXT NOT NULL,
    rendition TEXT NOT NULL,
    name TEXT NOT NULL,
    r2_key TEXT NOT NULL,
    kind TEXT NOT NULL,
    size INTEGER NOT NULL,
    uploaded_at INTEGER NOT NULL,
    PRIMARY KEY (source, event_id, rendition, name)
  );
  CREATE INDEX IF NOT EXISTS objects_event_idx ON objects(event_id);
  CREATE TABLE IF NOT EXISTS latest_manifests (
    source TEXT PRIMARY KEY,
    event_id TEXT NOT NULL,
    rendition TEXT NOT NULL,
    manifest_key TEXT NOT NULL,
    body TEXT NOT NULL,
    segment_names TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS timeline (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    source TEXT,
    detail TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
`;

export class StreamCoordinator extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(SCHEMA);
      const columns = new Set(
        ctx.storage.sql.exec<{ name: string }>("PRAGMA table_info(stream_state)").toArray().map((column) => column.name),
      );
      if (!columns.has("pending_id")) ctx.storage.sql.exec("ALTER TABLE stream_state ADD COLUMN pending_id TEXT");
      if (!columns.has("pending_started_at")) ctx.storage.sql.exec("ALTER TABLE stream_state ADD COLUMN pending_started_at INTEGER");
      if (!columns.has("source_last_seen")) ctx.storage.sql.exec("ALTER TABLE stream_state ADD COLUMN source_last_seen INTEGER");
      if (!columns.has("ingest_event")) ctx.storage.sql.exec("ALTER TABLE stream_state ADD COLUMN ingest_event TEXT");
      ctx.storage.transactionSync(() => {
        ctx.storage.sql.exec("UPDATE stream_state SET active_source = 'primary' WHERE active_source = 'live'");
        ctx.storage.sql.exec("UPDATE stream_state SET published_source = 'primary' WHERE published_source = 'live'");
        ctx.storage.sql.exec("UPDATE stream_state SET pending_source = 'primary' WHERE pending_source = 'live'");
        ctx.storage.sql.exec(
          `INSERT INTO objects (source, event_id, rendition, name, r2_key, kind, size, uploaded_at)
           SELECT 'primary', event_id, rendition, name, r2_key, kind, size, uploaded_at
           FROM objects WHERE source = 'live'
           ON CONFLICT (source, event_id, rendition, name) DO UPDATE SET
             r2_key = excluded.r2_key, kind = excluded.kind,
             size = excluded.size, uploaded_at = excluded.uploaded_at
           WHERE excluded.uploaded_at >= objects.uploaded_at`,
        );
        ctx.storage.sql.exec("DELETE FROM objects WHERE source = 'live'");
        ctx.storage.sql.exec(
          `INSERT INTO latest_manifests (source, event_id, rendition, manifest_key, body, segment_names, updated_at)
           SELECT 'primary', event_id, rendition, manifest_key, body, segment_names, updated_at
           FROM latest_manifests WHERE source = 'live'
           ON CONFLICT (source) DO UPDATE SET
             event_id = excluded.event_id, rendition = excluded.rendition,
             manifest_key = excluded.manifest_key, body = excluded.body,
             segment_names = excluded.segment_names, updated_at = excluded.updated_at
           WHERE excluded.updated_at >= latest_manifests.updated_at`,
        );
        ctx.storage.sql.exec("DELETE FROM latest_manifests WHERE source = 'live'");
        ctx.storage.sql.exec("UPDATE timeline SET source = 'primary' WHERE source = 'live'");
      });
      ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO stream_state (singleton, updated_at) VALUES (1, ?)",
        Date.now(),
      );
    });
  }

  private state(): StateRow {
    return this.ctx.storage.sql.exec<StateRow>("SELECT * FROM stream_state WHERE singleton = 1").one();
  }

  private event(kind: string, source: SourceRole | null, detail: string): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO timeline (kind, source, detail, created_at) VALUES (?, ?, ?, ?)",
      kind,
      source,
      detail,
      Date.now(),
    );
  }

  activateIngest(eventId: string): void {
    this.ctx.storage.sql.exec(
      "UPDATE stream_state SET ingest_event = ?, updated_at = ? WHERE singleton = 1",
      eventId,
      Date.now(),
    );
    this.event("ingest_activated", null, `Ingest session ${eventId} activated`);
  }

  deactivateIngest(): void {
    this.ctx.storage.sql.exec(
      "UPDATE stream_state SET ingest_event = NULL, updated_at = ? WHERE singleton = 1",
      Date.now(),
    );
    this.event("ingest_deactivated", null, "Ingest session deactivated");
  }

  acceptsIngest(eventId: string): boolean {
    return this.state().ingest_event === eventId;
  }

  async recordObject(input: RecordedObject): Promise<boolean> {
    if (this.state().ingest_event !== input.eventId) return false;
    const now = Date.now();
    this.ctx.storage.sql.exec(
      `INSERT INTO objects (source, event_id, rendition, name, r2_key, kind, size, uploaded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (source, event_id, rendition, name) DO UPDATE SET
         r2_key = excluded.r2_key,
         kind = excluded.kind,
         size = excluded.size,
         uploaded_at = excluded.uploaded_at`,
      input.source,
      input.eventId,
      input.rendition,
      input.name,
      input.r2Key,
      input.kind,
      input.size,
      now,
    );
    this.ctx.storage.sql.exec(
      "UPDATE stream_state SET source_last_seen = ?, updated_at = ? WHERE singleton = 1",
      now,
      now,
    );
    return true;
  }

  private missingObjects(input: PublicationInput): string[] {
    if (!input.segmentNames.length) return [];
    const knownNames = new Set<string>();
    for (let offset = 0; offset < input.segmentNames.length; offset += 50) {
      const names = input.segmentNames.slice(offset, offset + 50);
      const placeholders = names.map(() => "?").join(", ");
      for (const row of this.ctx.storage.sql.exec<{ name: string }>(
        `SELECT name FROM objects
         WHERE source = ? AND event_id = ? AND rendition = ? AND kind = 'segment'
           AND name IN (${placeholders})`,
        input.source,
        input.eventId,
        input.rendition,
        ...names,
      )) knownNames.add(row.name);
    }
    return input.segmentNames.filter((name) => !knownNames.has(name));
  }

  preparePublication(input: PublicationInput): PublicationDecision {
    const now = Date.now();
    const state = this.state();
    if (state.ingest_event !== input.eventId) return { accepted: false, reason: "stale_event" };

    const missing = this.missingObjects(input);
    if (missing.length) {
      this.event("publication_blocked", input.source, `${missing.length} referenced object(s) missing`);
      return { accepted: false, reason: "missing_objects", missing };
    }

    const previous = this.ctx.storage.sql.exec<LatestManifestRow>(
      "SELECT * FROM latest_manifests WHERE source = ? AND event_id = ?",
      input.source,
      input.eventId,
    ).toArray()[0];
    if (previous && input.mediaSequence < mediaSequence(previous.body)) {
      this.event("publication_blocked", input.source, "Media sequence regressed after an encoder restart");
      return { accepted: false, reason: "sequence_regression" };
    }

    this.ctx.storage.sql.exec(
      `INSERT INTO latest_manifests (source, event_id, rendition, manifest_key, body, segment_names, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (source) DO UPDATE SET
         event_id = excluded.event_id,
         rendition = excluded.rendition,
         manifest_key = excluded.manifest_key,
         body = excluded.body,
         segment_names = excluded.segment_names,
         updated_at = excluded.updated_at`,
      input.source,
      input.eventId,
      input.rendition,
      input.manifestKey,
      input.manifest,
      JSON.stringify(input.segmentNames),
      now,
    );

    if (sourcePublicationMode(state.active_source, input.source) === "standby") {
      this.event("standby_ready", input.source, `${input.source} has a complete standby manifest`);
      return { accepted: false, reason: "standby", activeSource: state.active_source };
    }

    return this.beginPublication(input);
  }

  promoteSource(source: SourceRole): PublicationDecision {
    const state = this.state();
    if (state.active_source === source) {
      return { accepted: false, reason: "already_active", activeSource: source };
    }
    if (state.pending_generation) return { accepted: false, reason: "publication_in_progress" };
    if (!state.ingest_event) return { accepted: false, reason: "source_not_ready" };

    const row = this.ctx.storage.sql.exec<LatestManifestRow>(
      `SELECT source, event_id, rendition, manifest_key, body, segment_names, updated_at
       FROM latest_manifests WHERE source = ? AND event_id = ?`,
      source,
      state.ingest_event,
    ).toArray()[0];
    if (!row) return { accepted: false, reason: "source_not_ready" };
    if (Date.now() - row.updated_at >= SOURCE_FRESHNESS_MS) {
      return { accepted: false, reason: "source_not_ready" };
    }

    const publication: PublicationInput = {
      source,
      eventId: row.event_id,
      rendition: row.rendition,
      manifestKey: row.manifest_key,
      manifest: row.body,
      segmentNames: JSON.parse(row.segment_names) as string[],
      mediaSequence: mediaSequence(row.body),
    };
    const missing = this.missingObjects(publication);
    if (missing.length) return { accepted: false, reason: "missing_objects", missing };
    if (state.active_source) {
      const active = this.ctx.storage.sql.exec<LatestManifestRow>(
        "SELECT * FROM latest_manifests WHERE source = ? AND event_id = ?",
        state.active_source,
        state.ingest_event,
      ).toArray()[0];
      if (active && publication.mediaSequence < mediaSequence(active.body)) {
        return { accepted: false, reason: "sequence_regression" };
      }
    }

    this.event("source_promotion_requested", source, `${source} promotion requested`);
    return this.beginPublication(publication);
  }

  private beginPublication(input: PublicationInput): PublicationDecision {
    const state = this.state();
    if (state.pending_generation) return { accepted: false, reason: "publication_in_progress" };
    const generation = state.generation + 1;
    const publicationId = crypto.randomUUID();
    this.ctx.storage.sql.exec(
      `UPDATE stream_state SET
         pending_generation = ?, pending_source = ?, pending_event = ?,
         pending_rendition = ?, pending_manifest_key = ?, pending_id = ?,
         pending_started_at = ?, updated_at = ?
       WHERE singleton = 1`,
      generation,
      input.source,
      input.eventId,
      input.rendition,
      input.manifestKey,
      publicationId,
      Date.now(),
      Date.now(),
    );
    this.event("publication_prepared", input.source, `Generation ${generation} ready for R2 commit`);
    return {
      accepted: true,
      reason: "ready",
      generation,
      publicationId,
      previousEtag: state.etag ?? undefined,
      publication: input,
    };
  }

  acceptsPublication(generation: number, publicationId: string, eventId: string): boolean {
    const state = this.state();
    return state.pending_generation === generation
      && state.pending_id === publicationId
      && state.pending_event === eventId
      && state.ingest_event === eventId;
  }

  commitPublicationToR2(
    generation: number,
    publicationId: string,
    publication: PublicationInput,
  ): Promise<PublicationCommitResult> {
    return this.ctx.blockConcurrencyWhile(async () => {
      const state = this.state();
      if (state.pending_generation !== generation
        || state.pending_id !== publicationId
        || state.pending_event !== state.ingest_event
        || !state.pending_source
        || !state.pending_event
        || !state.pending_manifest_key
        || publication.source !== state.pending_source
        || publication.eventId !== state.pending_event
        || publication.manifestKey !== state.pending_manifest_key) {
        return { committed: false, reason: "inactive" };
      }

      const putOptions: R2PutOptions = {
        httpMetadata: { contentType: "application/vnd.apple.mpegurl", cacheControl: "no-store" },
        customMetadata: {
          generation: String(generation),
          source: state.pending_source,
          eventId: state.pending_event,
          publicationId,
        },
        onlyIf: state.etag
          ? { etagMatches: state.etag.replace(/^"|"$/g, "") }
          : { etagDoesNotMatch: "*" },
      };
      let object: R2Object | null;
      try {
        object = await this.env.MEDIA.put(
          state.pending_manifest_key,
          publication.manifest,
          putOptions,
        );
        if (!object && !state.etag) {
          const stale = await this.env.MEDIA.head(state.pending_manifest_key);
          const staleGeneration = Number(stale?.customMetadata?.generation);
          if (stale && Number.isSafeInteger(staleGeneration) && staleGeneration >= generation) {
            return { committed: false, reason: "newer_canonical" };
          }
          object = await this.env.MEDIA.put(state.pending_manifest_key, publication.manifest, {
            ...putOptions,
            onlyIf: stale ? { etagMatches: stale.etag } : { etagDoesNotMatch: "*" },
          });
        }
      } catch {
        return { committed: false, reason: "transient" };
      }
      if (!object) return { committed: false, reason: "canonical_changed" };
      if (!this.commitPublication(generation, publicationId, object.etag)) {
        return { committed: false, reason: "inactive" };
      }
      return { committed: true, etag: object.etag };
    });
  }

  commitPublication(generation: number, publicationId: string, etag: string): boolean {
    const state = this.state();
    if (state.pending_generation !== generation || state.pending_id !== publicationId || !state.pending_source) return false;
    this.ctx.storage.sql.exec(
      `UPDATE stream_state SET
          generation = pending_generation,
          active_source = pending_source,
          published_source = pending_source,
         published_event = pending_event,
         published_rendition = pending_rendition,
         manifest_key = pending_manifest_key,
         etag = ?,
         pending_generation = NULL,
         pending_source = NULL,
         pending_event = NULL,
         pending_rendition = NULL,
         pending_manifest_key = NULL,
          pending_id = NULL,
          pending_started_at = NULL,
          updated_at = ?
       WHERE singleton = 1`,
      etag,
      Date.now(),
    );
    this.event("publication_committed", state.pending_source, `${state.pending_source} generation ${generation} is live`);
    return true;
  }

  recoverPublication(observedGeneration?: number, observedPublicationId?: string, observedEtag?: string): "none" | "committed" | "in_progress" | "cleared" {
    const state = this.state();
    if (!state.pending_generation || !state.pending_id) return "none";
    if (
      observedGeneration === state.pending_generation &&
      observedPublicationId === state.pending_id &&
      observedEtag
    ) {
      return this.commitPublication(state.pending_generation, state.pending_id, observedEtag) ? "committed" : "in_progress";
    }
    if (state.pending_started_at && Date.now() - state.pending_started_at < 15_000) return "in_progress";
    this.ctx.storage.sql.exec(
      `UPDATE stream_state SET
         pending_generation = NULL, pending_source = NULL, pending_event = NULL,
         pending_rendition = NULL, pending_manifest_key = NULL,
         pending_id = NULL, pending_started_at = NULL, updated_at = ?
       WHERE singleton = 1`,
      Date.now(),
    );
    this.event("publication_recovered", null, "Abandoned publication intent cleared after reconciliation");
    return "cleared";
  }

  getState(): CoordinatorState {
    const state = this.state();
    const objectCount = state.ingest_event
      ? this.ctx.storage.sql.exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM objects WHERE event_id = ?",
          state.ingest_event,
        ).one().count
      : 0;
    const timeline = this.ctx.storage.sql
      .exec<{ id: number; kind: string; source: string | null; detail: string; created_at: number }>(
        "SELECT id, kind, source, detail, created_at FROM timeline ORDER BY id DESC LIMIT 12",
      )
      .toArray();
    const sources: Record<SourceRole, SourceState> = {
      primary: { ready: false, eventId: null, rendition: null, updatedAt: null },
      backup: { ready: false, eventId: null, rendition: null, updatedAt: null },
    };
    const manifests = this.ctx.storage.sql.exec<LatestManifestStateRow>(
      "SELECT source, event_id, rendition, updated_at FROM latest_manifests",
    ).toArray();
    for (const manifest of manifests) {
      if (!isSourceRole(manifest.source)) continue;
      sources[manifest.source] = {
        ready: manifest.event_id === state.ingest_event && Date.now() - manifest.updated_at < SOURCE_FRESHNESS_MS,
        eventId: manifest.event_id,
        rendition: manifest.rendition,
        updatedAt: manifest.updated_at,
      };
    }
    return {
      activeSource: state.active_source,
      ingestEventId: state.ingest_event,
      generation: state.generation,
      publishedSource: state.published_source,
      eventId: state.published_event,
      rendition: state.published_rendition,
      manifestKey: state.manifest_key,
      publishedEtag: state.etag,
      pendingGeneration: state.pending_generation,
      pendingPublicationId: state.pending_id,
      pendingStartedAt: state.pending_started_at,
      lastSeen: state.source_last_seen,
      objectCount,
      sources,
      timeline,
      updatedAt: state.updated_at,
    };
  }

  async reset(): Promise<void> {
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("DELETE FROM objects");
      this.ctx.storage.sql.exec("DELETE FROM latest_manifests");
      this.ctx.storage.sql.exec("DELETE FROM timeline");
      this.ctx.storage.sql.exec(
        `UPDATE stream_state SET
            ingest_event = NULL, active_source = NULL,
            generation = MAX(generation, COALESCE(pending_generation, generation)),
            published_source = NULL,
           published_event = NULL, published_rendition = NULL, manifest_key = NULL,
           etag = NULL, pending_generation = NULL, pending_source = NULL,
           pending_event = NULL, pending_rendition = NULL, pending_manifest_key = NULL,
           pending_id = NULL, pending_started_at = NULL,
             source_last_seen = NULL,
             updated_at = ?
         WHERE singleton = 1`,
        Date.now(),
      );
    });
    await this.ctx.storage.deleteAlarm();
    this.event("demo_reset", null, "Coordinator and live namespace reset");
  }
}
