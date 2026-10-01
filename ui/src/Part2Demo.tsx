import { useEffect, useRef, useState } from "react";
import { Badge } from "@cloudflare/kumo/components/badge";
import { Button } from "@cloudflare/kumo/components/button";
import { ClipboardText } from "@cloudflare/kumo/components/clipboard-text";
import {
  ArrowsClockwiseIcon,
  BroadcastIcon,
  CloudArrowUpIcon,
  DatabaseIcon,
  PlayIcon,
  ShieldCheckIcon,
  StackIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";

type TimelineItem = { id: number; kind: string; source: string | null; detail: string; created_at: number };
type SourceRole = "primary" | "backup";
type SourceState = { ready: boolean; eventId: string | null; rendition: string | null; updatedAt: number | null };
type Part2State = {
  activeSource: SourceRole | null;
  ingestEventId: string | null;
  generation: number;
  publishedSource: SourceRole | null;
  eventId: string | null;
  pendingGeneration: number | null;
  objectCount: number;
  sources: Record<SourceRole, SourceState>;
  timeline: TimelineItem[];
};
type LiveFile = { key: string; size: number };
type StateResponse = { state: Part2State; files: LiveFile[] };
type AccessResponse = { signedUrl: string };
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
type PublisherResponse = {
  protocol: string;
  eventId: string;
  rendition: string;
  expiresAt: string;
  ttlSeconds: number;
  sources: Record<SourceRole, PublisherTarget>;
  mediaLive: {
    channelClass: string;
    destinationAUrl: string;
    destinationBUrl: string;
    cdnSettings: string;
    outputSelection: string;
    directoryStructure: string;
    nameModifier: string;
    segmentModifier: string;
    segmentLengthSeconds: number;
    indexNSegments: number;
    keepSegments: number;
    credentials: string;
    expectedMediaPlaylist: string;
  };
};
type ContainerStatusResponse = {
  lifecycle: string;
  lastChange: number;
  process: null | {
    running?: boolean;
    delivery?: string;
    hlsStartNumber?: number;
    uptimeSeconds?: number;
    dvrLocation?: string;
    lastError?: string | null;
  };
};
type ContainerStatusesResponse = Record<SourceRole, ContainerStatusResponse>;
type LiveLatency = 3 | 6 | 12 | 20;
const SOURCE_ROLES: SourceRole[] = ["primary", "backup"];
const LATENCY_PRESETS: Array<{ seconds: LiveLatency; label: string; windowSeconds: number; maxLatencySeconds: number }> = [
  { seconds: 3, label: "Very low", windowSeconds: 16, maxLatencySeconds: 12 },
  { seconds: 6, label: "Low", windowSeconds: 24, maxLatencySeconds: 18 },
  { seconds: 12, label: "Balanced", windowSeconds: 40, maxLatencySeconds: 30 },
  { seconds: 20, label: "Resilient", windowSeconds: 60, maxLatencySeconds: 50 },
];

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const body = await response.json() as T & { detail?: string; error?: string; reason?: string };
  if (!response.ok) throw new Error(body.detail ?? body.reason ?? body.error ?? `Request failed with ${response.status}`);
  return body;
}

function formatTime(value: number) {
  return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function Part2Demo() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<import("hls.js").default | null>(null);
  const [snapshot, setSnapshot] = useState<StateResponse | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [playing, setPlaying] = useState(false);
  const [clock, setClock] = useState(() => new Date());
  const [publisher, setPublisher] = useState<PublisherResponse | null>(null);
  const [sourceMode, setSourceMode] = useState<"container" | "external">("container");
  const [containerStatuses, setContainerStatuses] = useState<ContainerStatusesResponse | null>(null);
  const [liveLatency, setLiveLatency] = useState<LiveLatency>(12);

  async function refresh() {
    const [nextSnapshot, nextContainerStatus] = await Promise.all([
      api<StateResponse>("/api/part2/state"),
      api<ContainerStatusesResponse>("/api/part2/container/status"),
    ]);
    setSnapshot(nextSnapshot);
    setContainerStatuses(nextContainerStatus);
  }

  useEffect(() => {
    void refresh().catch((caught) => setError(errorMessage(caught)));
    const timer = window.setInterval(() => void refresh().catch(() => undefined), 5000);
    return () => {
      window.clearInterval(timer);
      hlsRef.current?.destroy();
    };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setClock(new Date()), 250);
    return () => window.clearInterval(timer);
  }, []);

  async function withBusy(label: string, operation: () => Promise<void>) {
    setBusy(label);
    setError("");
    try {
      await operation();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy("");
    }
  }

  async function postAndRefresh(label: string, path: string, body?: object) {
    await withBusy(label, async () => {
      await api(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      await refresh();
    });
  }

  async function playLive(targetLatency: LiveLatency = liveLatency) {
    await withBusy("play", async () => {
      const issued = await api<AccessResponse>("/api/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resource: "live", ttlSeconds: 300 }),
      });
      const exchange = await fetch(issued.signedUrl);
      if (!exchange.ok) throw new Error(await exchange.text());
      const session = exchange.headers.get("X-Demo-Session-Token");
      if (!session) throw new Error("No live playback session was returned");
      const playbackUrl = new URL(issued.signedUrl);
      playbackUrl.search = "";
      playbackUrl.searchParams.set("hdntl", session);
      playbackUrl.searchParams.set("latency", String(targetLatency));

      const video = videoRef.current;
      if (!video) return;
      hlsRef.current?.destroy();
      const { default: Hls } = await import("hls.js");
      if (Hls.isSupported()) {
        const preset = LATENCY_PRESETS.find((candidate) => candidate.seconds === targetLatency) ?? LATENCY_PRESETS[1];
        const hls = new Hls({
          enableWorker: true,
          lowLatencyMode: false,
          liveSyncDuration: targetLatency,
          liveMaxLatencyDuration: preset.maxLatencySeconds,
          maxLiveSyncPlaybackRate: 1.1,
          maxBufferLength: preset.windowSeconds,
          maxMaxBufferLength: preset.windowSeconds + 30,
          backBufferLength: 30,
          maxBufferHole: 1,
          highBufferWatchdogPeriod: 1,
        });
        hlsRef.current = hls;
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          setPlaying(true);
          void video.play().catch(() => undefined);
        });
        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (!data.fatal) return;
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
            hls.startLoad();
          } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
            hls.recoverMediaError();
          } else {
            setError(`Live playback failed: ${data.details}`);
          }
        });
        hls.loadSource(playbackUrl.toString());
        hls.attachMedia(video);
      } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
        video.src = playbackUrl.toString();
        await video.play();
        setPlaying(true);
      }
    });
  }

  function changeLiveLatency(next: LiveLatency) {
    setLiveLatency(next);
    if (playing) void playLive(next);
  }

  async function preparePublisher() {
    await withBusy("publisher", async () => {
      setPublisher(await api<PublisherResponse>("/api/part2/publisher", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ publisher: "medialive" }),
      }));
      await refresh();
    });
  }

  async function startContainerPublishers(source?: SourceRole) {
    const label = source ? `container-start-${source}` : "container-start";
    await withBusy(label, async () => {
      setPublisher(null);
      await api("/api/part2/container/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: source ? JSON.stringify({ source }) : undefined,
      });
      await refresh();
    });
  }

  async function stopContainerPublishers(source?: SourceRole) {
    await postAndRefresh(
      source ? `container-stop-${source}` : "container-stop",
      "/api/part2/container/stop",
      source ? { source } : undefined,
    );
  }

  const state = snapshot?.state;
  const files = snapshot?.files ?? [];
  const primaryTarget = publisher?.sources.primary;
  const backupTarget = publisher?.sources.backup;
  const isContainerRunning = (source: SourceRole) => {
    const lifecycle = containerStatuses?.[source].lifecycle;
    return lifecycle === "healthy" || lifecycle === "running";
  };
  const isSourceFresh = (source: SourceRole) => {
    const sourceState = state?.sources[source];
    return Boolean(sourceState?.ready && sourceState.updatedAt && clock.getTime() - sourceState.updatedAt < 10_000);
  };
  const anyContainerRunning = SOURCE_ROLES.some(isContainerRunning);
  const allContainersRunning = SOURCE_ROLES.every(isContainerRunning);
  const liveTimestamp = `${clock.toISOString().slice(0, 19).replace("T", " ")} UTC`;

  return (
    <>
      <section className="part2-intro section-line shell" aria-labelledby="part2-title">
        <div className="eyebrow"><span>Part 2 demo</span> · Push ingest and coordinated publication</div>
        <div className="part2-title-row">
          <h2 id="part2-title">Primary and backup ingest.<br /><em>One stable viewer feed.</em></h2>
          <p>Both sources write into isolated R2 namespaces. A per-stream Durable Object validates complete manifests and atomically switches the canonical playlist without changing the viewer URL or session.</p>
        </div>
        <figure className="architecture-diagram part2-architecture">
          <div className="diagram-canvas part2-diagram">
            <section className="diagram-stage">
              <header><span>01</span><div><small>LIVE SOURCE</small><strong>Publisher choice</strong></div></header>
              <div className="diagram-node source-primary">
                <StackIcon />
                <div><strong>Primary ingest</strong><span>Managed container or MediaLive pipeline A</span></div>
              </div>
              <div className="diagram-node source-external">
                <CloudArrowUpIcon />
                <div><strong>Backup ingest</strong><span>MediaLive pipeline B, FFmpeg or Docker</span></div>
              </div>
            </section>

            <div className="diagram-connector"><span>authenticated HLS PUT</span></div>

            <section className="diagram-stage edge-stage">
              <header><span>02</span><div><small>INGEST + CONTROL</small><strong>Atomic publication</strong></div></header>
              <div className="diagram-node emphasis">
                <ShieldCheckIcon />
                <div><strong>Ingest Worker</strong><span>Authenticates, streams bytes and validates complete manifests</span></div>
              </div>
              <div className="diagram-node compact control-node">
                <StackIcon />
                <div><strong>StreamCoordinator</strong><span>Durable Object · source arbitration + generation</span></div>
              </div>
            </section>

            <div className="diagram-connector"><span>commit generation</span></div>

            <section className="diagram-stage">
              <header><span>03</span><div><small>MEDIA PLANE</small><strong>Durable storage</strong></div></header>
              <div className="diagram-node">
                <DatabaseIcon />
                <div><strong>Private R2</strong><span>Source-qualified media and canonical playlists</span></div>
              </div>
            </section>

            <div className="diagram-connector"><span>signed HLS</span></div>

            <section className="diagram-stage viewer-stage">
              <header><span>04</span><div><small>DELIVERY</small><strong>Viewer edge</strong></div></header>
              <div className="diagram-node delivery-node">
                <BroadcastIcon />
                <div><strong>Protected player</strong><span>Sliding live window from the active generation</span></div>
              </div>
              <div className="diagram-capabilities">
                <span>hdntl</span><span>buffered</span><span>timestamped</span>
              </div>
            </section>
          </div>
          <figcaption className="diagram-sequence">
            <span><b>01</b> Ingest both sources</span>
            <span><b>02</b> Validate complete packages</span>
            <span><b>03</b> Promote one generation</span>
            <span><b>04</b> Keep viewer URL stable</span>
          </figcaption>
        </figure>
      </section>

      <section className="external-publisher section-line shell" aria-labelledby="publisher-title">
        <div className="section-heading">
          <div><span className="section-index">05 / LIVE SOURCE</span><h2 id="publisher-title">Choose how to go live</h2></div>
          <Badge variant={state?.activeSource ? "success" : "neutral"} appearance="dot">{state?.activeSource ? "Live publishing" : "Source idle"}</Badge>
        </div>

        <div className="source-mode-grid" role="group" aria-label="Live source type">
          <button className={`source-mode-card ${sourceMode === "container" ? "active" : ""}`} type="button" onClick={() => setSourceMode("container")}>
            <StackIcon /><span>MANAGED REDUNDANCY</span><strong>Cloudflare Containers</strong><p>Start synchronized primary and backup FFmpeg test feeds with one click.</p><small>Primary + backup</small>
          </button>
          <button className={`source-mode-card ${sourceMode === "external" ? "active" : ""}`} type="button" onClick={() => setSourceMode("external")}>
            <CloudArrowUpIcon /><span>REDUNDANT EXTERNAL</span><strong>AWS MediaLive or two encoders</strong><p>Push primary and backup HLS over separate authenticated URLs.</p><small>Primary + backup</small>
          </button>
        </div>

        {sourceMode === "container" ? (
          <div className="publisher-grid">
            <article className="publisher-setup workers-card">
              <div className="publisher-kicker"><StackIcon /><span>MANAGED PRIMARY + BACKUP</span></div>
              <h3>Start synchronized sources</h3>
              <p>Two containers generate role-labelled timestamped feeds on one aligned HLS timeline, then FFmpeg pushes segments and playlists directly into isolated Worker ingest paths.</p>
              <div className="publisher-actions">
                <Button className="workers-button primary-action" variant="primary" icon={PlayIcon} loading={busy === "container-start"} disabled={Boolean(busy) || anyContainerRunning} onClick={() => void startContainerPublishers()}>Start both</Button>
                <Button className="workers-button" variant="outline" disabled={Boolean(busy) || !anyContainerRunning} loading={busy === "container-stop"} onClick={() => void stopContainerPublishers()}>Stop both</Button>
              </div>
              <div className="publisher-warning"><WarningCircleIcon />Starting both sources clears the current event. Stop one role below to simulate a failure, then promote the healthy source without changing the viewer URL.</div>
            </article>

            <article className="publisher-config workers-card">
              <div className="publisher-config-head">
                <div><span className="section-index">CONTAINER STATUS</span><h3>LivePublisherContainer pair</h3></div>
                <Badge variant={allContainersRunning ? "success" : anyContainerRunning ? "warning" : "neutral"} appearance="dot">{allContainersRunning ? "Both running" : anyContainerRunning ? "Degraded" : "Stopped"}</Badge>
              </div>
              <div className="container-pair">
                {SOURCE_ROLES.map((source) => {
                  const status = containerStatuses?.[source];
                  const running = isContainerRunning(source);
                  const publishing = isSourceFresh(source);
                  const encoding = Boolean(status?.process?.running);
                  return (
                    <section className="container-source" key={source}>
                      <header><div><small>{source.toUpperCase()}</small><strong>live-demo-{source}</strong></div><Badge variant={publishing ? "success" : encoding || running ? "warning" : "neutral"} appearance="dot">{publishing ? "Publishing" : encoding ? "Encoding" : running ? "Starting" : status?.lifecycle ?? "Stopped"}</Badge></header>
                      <div className="container-readout">
                        <div><small>LIFECYCLE</small><strong>{status?.lifecycle?.toUpperCase() ?? "UNKNOWN"}</strong></div>
                        <div><small>TRANSPORT</small><strong>{status?.process?.delivery?.toUpperCase() ?? "HTTP PUT"}</strong></div>
                        <div><small>SEQUENCE BASE</small><strong>{status?.process?.hlsStartNumber ?? "—"}</strong></div>
                        <div><small>ROLE</small><strong>{source.toUpperCase()}</strong></div>
                      </div>
                      {status?.process?.lastError ? <div className="publisher-error"><WarningCircleIcon weight="fill" />{status.process.lastError}</div> : null}
                      <Button className="workers-button container-role-action" variant="outline" disabled={Boolean(busy) || (!running && !state?.ingestEventId)} loading={busy === `container-${running ? "stop" : "start"}-${source}`} onClick={() => void (running ? stopContainerPublishers(source) : startContainerPublishers(source))}>{running ? `Stop ${source}` : `Restart ${source}`}</Button>
                    </section>
                  );
                })}
              </div>
              <div className="container-boundary">
                <DatabaseIcon />
                <div><strong>Container boundary</strong><p>Both FFmpeg processes are disposable source tooling. The Worker validates each package; R2 retains media and the Durable Object controls publication.</p></div>
              </div>
            </article>
          </div>
        ) : (
          <div className="publisher-grid">
            <article className="publisher-setup workers-card">
              <div className="publisher-kicker"><CloudArrowUpIcon /><span>AWS MEDIALIVE STANDARD</span></div>
              <h3>Connect both pipelines directly</h3>
              <p>Create source-scoped destinations for MediaLive pipelines A and B. Both can publish concurrently without a relay, RTMP gateway, or destination credentials.</p>
              <Button className="workers-button primary-action full" variant="primary" icon={CloudArrowUpIcon} loading={busy === "publisher"} disabled={Boolean(busy)} onClick={() => void preparePublisher()}>
                Create primary + backup destinations
              </Button>
              <div className="publisher-warning"><WarningCircleIcon />Creating destinations stops the managed container and clears the current event. Both event-scoped URLs expire after six hours.</div>
            </article>

            <article className="publisher-config workers-card">
              <div className="publisher-config-head">
                 <div><span className="section-index">PUBLISH CREDENTIALS</span><h3>{publisher ? publisher.rendition : "No endpoint issued"}</h3></div>
                {publisher && <Badge variant="warning">Expires {new Date(publisher.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</Badge>}
              </div>
              {publisher && primaryTarget && backupTarget ? (
                <>
                  <section className="medialive-config">
                    <header><span>AWS</span><strong>HLS output group configuration</strong></header>
                    <div className="publisher-field"><label>Destination A URL · primary</label><ClipboardText size="sm" text={publisher.mediaLive.destinationAUrl} /></div>
                    <div className="publisher-field"><label>Destination B URL · backup</label><ClipboardText size="sm" text={publisher.mediaLive.destinationBUrl} /></div>
                    <dl className="medialive-settings">
                      <div><dt>Channel class</dt><dd>{publisher.mediaLive.channelClass}</dd></div>
                      <div><dt>CDN settings</dt><dd>{publisher.mediaLive.cdnSettings}</dd></div>
                      <div><dt>Name modifier</dt><dd>{publisher.mediaLive.nameModifier}</dd></div>
                      <div><dt>Segment modifier</dt><dd>{publisher.mediaLive.segmentModifier}</dd></div>
                      <div><dt>Segment length</dt><dd>{publisher.mediaLive.segmentLengthSeconds} seconds</dd></div>
                      <div><dt>Index n segments</dt><dd>{publisher.mediaLive.indexNSegments}</dd></div>
                      <div><dt>Keep segments</dt><dd>{publisher.mediaLive.keepSegments}</dd></div>
                      <div><dt>Directory structure</dt><dd>{publisher.mediaLive.directoryStructure}</dd></div>
                      <div><dt>Output selection</dt><dd>{publisher.mediaLive.outputSelection}</dd></div>
                    </dl>
                    <p>Leave destination credentials empty. Pipelines A and B publish source-scoped copies of <code>{publisher.mediaLive.expectedMediaPlaylist}</code>; only the selected source reaches the stable viewer playlist.</p>
                  </section>
                  <div className="publisher-field"><label>Primary generic HLS publish URL</label><ClipboardText size="sm" text={primaryTarget.ingestUrl} /></div>
                  <div className="publisher-field"><label>Backup generic HLS publish URL</label><ClipboardText size="sm" text={backupTarget.ingestUrl} /></div>
                  <div className="publisher-methods">
                    <section>
                      <header><span>OBS</span><strong>Primary custom output</strong></header>
                      <dl><div><dt>Output type</dt><dd>{primaryTarget.obs.outputType}</dd></div><div><dt>Container</dt><dd>{primaryTarget.obs.containerFormat}</dd></div></dl>
                      <label>Muxer settings</label><ClipboardText size="sm" text={primaryTarget.obs.muxerSettings} />
                    </section>
                    <section>
                      <header><span>CLI</span><strong>Backup FFmpeg command</strong></header>
                      <p>Replace <code>INPUT</code> with the backup file or capture device.</p><ClipboardText size="sm" text={backupTarget.ffmpegCommand} />
                    </section>
                  </div>
                  <section className="docker-publisher-command">
                    <header><span>DOCKER</span><strong>Independent synthetic publishers</strong></header>
                    <p>Run either or both from the project root. Each command uses an independently scoped source URL.</p>
                    <div className="publisher-field"><label>Primary container</label><ClipboardText size="sm" text={primaryTarget.dockerCommand} /></div>
                    <div className="publisher-field"><label>Backup container</label><ClipboardText size="sm" text={backupTarget.dockerCommand} /></div>
                  </section>
                   <div className="protocol-note"><ShieldCheckIcon /><span><strong>{publisher.protocol}</strong> Each token is also scoped to its primary or backup role. Promoting a source does not change the viewer URL.</span></div>
                </>
              ) : (
                <div className="publisher-empty"><BroadcastIcon /><strong>Generate paired MediaLive destinations</strong><p>Part 2 will provide separate primary and backup HLS Basic PUT settings plus generic encoder options.</p></div>
              )}
            </article>
          </div>
        )}
      </section>

      <section className="part2-console section-line shell" aria-labelledby="operator-title">
        <div className="section-heading">
          <div><span className="section-index">06 / LIVE OPERATIONS</span><h2 id="operator-title">Run the publication handoff</h2></div>
          <Badge variant={state?.activeSource ? "success" : "neutral"} appearance="dot">
             {state?.activeSource ? `${state.activeSource} · generation ${state.generation}` : "Coordinator idle"}
          </Badge>
        </div>
        {error && <div className="error-banner"><WarningCircleIcon weight="fill" />{error}</div>}

        <div className="operator-grid">
          <div className="operation-rail">
            <article className="operation-step">
              <span>00</span><div><strong>Reset event</strong><p>Clear the live namespace and SQLite state.</p></div>
              <Button className="workers-button" variant="outline" icon={ArrowsClockwiseIcon} disabled={Boolean(busy)} loading={busy === "reset"} onClick={() => void postAndRefresh("reset", "/api/part2/reset")}>Reset</Button>
            </article>
            <article className="operation-step">
              <span>01</span><div><strong>Promote primary</strong><p>Atomically move the stable viewer playlist to the latest complete primary manifest.</p></div>
              <Button className="workers-button" variant="outline" disabled={Boolean(busy) || !isSourceFresh("primary") || state?.activeSource === "primary"} loading={busy === "switch-primary"} onClick={() => void postAndRefresh("switch-primary", "/api/part2/failover", { source: "primary" })}>Use primary</Button>
            </article>
            <article className="operation-step">
              <span>02</span><div><strong>Promote backup</strong><p>Switch the canonical playlist without reloading or retokenizing connected viewers.</p></div>
              <Button className="workers-button" variant="outline" disabled={Boolean(busy) || !isSourceFresh("backup") || state?.activeSource === "backup"} loading={busy === "switch-backup"} onClick={() => void postAndRefresh("switch-backup", "/api/part2/failover", { source: "backup" })}>Use backup</Button>
            </article>
          </div>

          <aside className="coordinator-monitor">
            <div className="monitor-head"><span>STREAM_COORDINATOR / live-demo</span><span className="monitor-pulse" /></div>
            <div className="state-readout">
              <div><small>ACTIVE SOURCE</small><strong>{state?.activeSource?.toUpperCase() ?? "NONE"}</strong></div>
              <div><small>GENERATION</small><strong>{String(state?.generation ?? 0).padStart(2, "0")}</strong></div>
              <div><small>LIVE OBJECTS</small><strong>{state?.objectCount ?? 0}</strong></div>
              <div><small>LATENCY TARGET</small><strong>{liveLatency}S</strong></div>
            </div>
            <div className="source-status-list">
              {SOURCE_ROLES.map((source) => {
                const sourceState = state?.sources[source];
                const active = state?.activeSource === source;
                const fresh = isSourceFresh(source);
                return (
                  <div className={active ? "active" : ""} key={source}>
                    <span>{source}</span>
                    <strong>{active && fresh ? "ACTIVE" : fresh ? "STANDBY READY" : sourceState?.eventId === state?.ingestEventId ? "STALE" : "WAITING"}</strong>
                    <small>{sourceState?.updatedAt ? `manifest ${formatTime(sourceState.updatedAt)}` : "no complete manifest"}</small>
                  </div>
                );
              })}
            </div>
            <div className="timeline">
              <div className="timeline-label">SQLITE EVENT LOG</div>
              {(state?.timeline ?? []).length ? state?.timeline.map((item) => (
                <div className="timeline-row" key={item.id}>
                  <time>{formatTime(item.created_at)}</time>
                  <span className={item.source ?? "system"}>{item.source ?? "system"}</span>
                  <p>{item.detail}</p>
                </div>
              )) : <div className="timeline-empty">Start the managed container or connect an external publisher to begin.</div>}
            </div>
          </aside>
        </div>
      </section>

      <section className="part2-output section-line shell" aria-labelledby="output-title">
        <div className="section-heading">
          <div><span className="section-index">07 / MEDIA PLANE</span><h2 id="output-title">Inspect storage and protected output</h2></div>
          <span className="mono-label">R2 bytes · DO metadata · protected playback</span>
        </div>
        <div className="part2-output-grid">
          <article className="live-storage workers-card">
            <div className="storage-head"><div><DatabaseIcon /><span>private://media/live</span></div><Badge variant="neutral">{files.length} objects</Badge></div>
            <div className="storage-list">
              {files.length ? files.map((file) => (
                <div key={file.key} className={file.key.includes("current/") ? "canonical-file" : ""}>
                  <span>{file.key}</span><small>{Math.max(1, Math.round(file.size / 1024))} KB</small>
                </div>
              )) : <p>Live objects appear here after the first push.</p>}
            </div>
          </article>

          <article className="workers-card live-player-card">
            <div className="player-topline">
              <div><span className="section-index">TIMESTAMPED LIVE OUTPUT</span><h3>/media/live/master.m3u8</h3></div>
              <Badge variant={playing ? "success" : state?.publishedSource ? "warning" : "neutral"} appearance="dot">{playing ? "Playing" : state?.publishedSource ? "Publish ready" : "Waiting"}</Badge>
            </div>
            <div className="latency-control" role="group" aria-label="Live latency target">
              <div><span>LATENCY TARGET</span><small>Lower latency has less protection from network jitter.</small></div>
              <div className="latency-options">
                {LATENCY_PRESETS.map((preset) => (
                  <button key={preset.seconds} type="button" className={liveLatency === preset.seconds ? "active" : ""} aria-pressed={liveLatency === preset.seconds} onClick={() => changeLiveLatency(preset.seconds)}>
                    <strong>{preset.label}</strong><span>{preset.seconds}s</span>
                  </button>
                ))}
              </div>
            </div>
            <div className="video-frame">
              <video ref={videoRef} controls playsInline muted />
              {!playing && <div className="video-empty"><Button className="workers-button video-start" variant="primary" icon={PlayIcon} disabled={!state?.publishedSource} loading={busy === "play"} onClick={() => void playLive()}>Issue token + play</Button><p>The same edge token exchange protects the coordinated output.</p></div>}
              <div className="live-ribbon"><span /> GENERATION {state?.generation ?? 0} · {state?.publishedSource?.toUpperCase() ?? "NO SOURCE"}</div>
              <div className="feed-clock" aria-live="off"><span>{state?.publishedSource ? "LIVE" : "UTC"}</span><time dateTime={clock.toISOString()}>{liveTimestamp}</time></div>
            </div>
            <div className="live-feed-meta">
              <span><BroadcastIcon />Target {liveLatency}s behind live edge</span>
              <span><ArrowsClockwiseIcon />Recent {LATENCY_PRESETS.find((preset) => preset.seconds === liveLatency)?.windowSeconds ?? 40}s manifest window</span>
            </div>
          </article>
        </div>
      </section>
    </>
  );
}
