import { useEffect, useRef, useState } from "react";
import { Badge } from "@cloudflare/kumo/components/badge";
import { Button } from "@cloudflare/kumo/components/button";
import { ClipboardText } from "@cloudflare/kumo/components/clipboard-text";
import { Switch } from "@cloudflare/kumo/components/switch";
import {
  CheckCircleIcon,
  CloudArrowDownIcon,
  DatabaseIcon,
  KeyIcon,
  LockKeyIcon,
  PlayIcon,
  ShieldCheckIcon,
  VideoCameraIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import { Part2Demo } from "./Part2Demo";
import { SourceNavigator } from "./SourceNavigator";
import { isPart2Path, maskSessionToken } from "./demo-helpers";

type AccessResponse = {
  tokenType: "hdnts";
  token: string;
  signedUrl: string;
  claims: { st: number; exp: number; acl: string; id: string; ip?: string };
};

type LogItem = { time: string; label: string; detail: string; state: "ok" | "pending" | "error" };

function Brackets() {
  return (
    <>
      <i className="corner corner-tl" />
      <i className="corner corner-tr" />
      <i className="corner corner-bl" />
      <i className="corner corner-br" />
    </>
  );
}

function nowLabel() {
  return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function SiteHeader({
  active,
  status,
  statusState = "ready",
}: {
  active: "part-1" | "part-2";
  status: string;
  statusState?: "checking" | "ready" | "error";
}) {
  return (
    <header className="nav shell">
      <a className="brand" href="/part-1/" aria-label="Cloudflare protected HLS demo">
        <span className="brand-mark"><CloudArrowDownIcon weight="fill" /></span>
        <span>Cloudflare</span>
        <span className="brand-divider" />
        <span className="brand-product">Protected HLS</span>
      </a>
      <nav className="page-links" aria-label="Demo pages">
        <a className={active === "part-1" ? "active" : ""} href="/part-1/">Part 1</a>
        <a className={active === "part-2" ? "active" : ""} href="/part-2/">Part 2</a>
      </nav>
      <div className="nav-status">
        <span className={`status-dot ${statusState}`} />
        {status}
      </div>
    </header>
  );
}

function Part2Page() {
  return (
    <main>
      <div className="dot-grid" aria-hidden="true" />
      <div className="guide guide-left" aria-hidden="true" />
      <div className="guide guide-right" aria-hidden="true" />
      <SiteHeader active="part-2" status="Live origin ready" />
      <Part2Demo />
      <footer className="shell">
        <span>Cloudflare Workers + Durable Objects + R2 + Containers</span>
        <span>Reference implementation · not production credentials</span>
      </footer>
    </main>
  );
}

export function App() {
  return isPart2Path(window.location.pathname) ? <Part2Page /> : <Part1Page />;
}

function Part1Page() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<import("hls.js").default | null>(null);
  const [health, setHealth] = useState<"checking" | "ready" | "error">("checking");
  const [access, setAccess] = useState<AccessResponse | null>(null);
  const [sessionToken, setSessionToken] = useState("");
  const [sessionPlaybackUrl, setSessionPlaybackUrl] = useState("");
  const [manifest, setManifest] = useState("");
  const [bindIp, setBindIp] = useState(false);
  const [ttl, setTtl] = useState(300);
  const [busy, setBusy] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState("");
  const [directDenied, setDirectDenied] = useState<boolean | null>(null);
  const [logs, setLogs] = useState<LogItem[]>([
    { time: "--:--:--", label: "Awaiting request", detail: "Run the flow to inspect each edge decision.", state: "pending" },
  ]);

  function addLog(label: string, detail: string, state: LogItem["state"] = "ok") {
    setLogs((items) => [{ time: nowLabel(), label, detail, state }, ...items].slice(0, 7));
  }

  useEffect(() => {
    fetch("/api/health")
      .then(async (response) => {
        const body = await response.json() as { media: string };
        if (!response.ok || body.media !== "ready") throw new Error("Media is not ready");
        setHealth("ready");
      })
      .catch(() => setHealth("error"));
    return () => hlsRef.current?.destroy();
  }, []);

  async function issueToken() {
    setError("");
    const response = await fetch("/api/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bindIp, ttlSeconds: ttl }),
    });
    if (!response.ok) throw new Error("The token issuer rejected the request");
    const issued = await response.json() as AccessResponse;
    setAccess(issued);
    setSessionToken("");
    setSessionPlaybackUrl("");
    setManifest("");
    addLog("hdnts issued", `${ttl}s access window · ACL ${issued.claims.acl}`);
    return issued;
  }

  async function exchangeToken(issued = access) {
    if (!issued) throw new Error("Issue an access token first");
    setError("");
    const response = await fetch(issued.signedUrl);
    const text = await response.text();
    if (!response.ok) throw new Error(text || "The delivery Worker rejected the token");
    const session = response.headers.get("X-Demo-Session-Token") ?? "";
    if (!session) throw new Error("No session token was returned");
    const playbackUrl = new URL(issued.signedUrl);
    playbackUrl.search = "";
    playbackUrl.searchParams.set("hdntl", session);
    setSessionToken(session);
    setSessionPlaybackUrl(playbackUrl.toString());
    setManifest(maskSessionToken(text));
    const protectedUris = (text.match(/hdntl=/g) ?? []).length;
    addLog("hdntl exchanged", `${protectedUris} child URIs rewritten · playlist private/no-store`);
    return playbackUrl.toString();
  }

  async function startPlayback(sourceUrl = sessionPlaybackUrl) {
    if (!sourceUrl || !videoRef.current) throw new Error("Complete steps 1 and 2 before playback");
    const video = videoRef.current;
    hlsRef.current?.destroy();
    const { default: Hls } = await import("hls.js");
    if (Hls.isSupported()) {
      const hls = new Hls({ enableWorker: true });
      hlsRef.current = hls;
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        setPlaying(true);
        addLog("Playback authorized", "HLS.js loaded protected variants and segments from R2");
        void video.play().catch(() => undefined);
      });
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (data.fatal) {
          setPlaying(false);
          setError(`Playback error: ${data.details}`);
          addLog("Playback failed", data.details, "error");
        }
      });
      hls.loadSource(sourceUrl);
      hls.attachMedia(video);
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = sourceUrl;
      void video.play().catch(() => undefined);
      setPlaying(true);
      addLog("Playback authorized", "Native HLS loaded the protected stream");
    } else {
      throw new Error("This browser does not support HLS playback");
    }
  }

  async function runFlow() {
    setBusy(true);
    setError("");
    try {
      const issued = await issueToken();
      const playbackUrl = await exchangeToken(issued);
      await startPlayback(playbackUrl);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "The demo flow failed";
      setError(message);
      addLog("Flow rejected", message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function checkDirectAccess() {
    const response = await fetch("/media/demo/master.m3u8");
    const denied = response.status === 401;
    setDirectDenied(denied);
    addLog(denied ? "Unsigned request denied" : "Protection check failed", `GET master.m3u8 → ${response.status}`, denied ? "ok" : "error");
  }

  const expiresIn = access ? Math.max(0, access.claims.exp - Math.floor(Date.now() / 1000)) : 0;

  return (
    <main>
      <div className="dot-grid" aria-hidden="true" />
      <div className="guide guide-left" aria-hidden="true" />
      <div className="guide guide-right" aria-hidden="true" />

      <SiteHeader
        active="part-1"
        status={health === "ready" ? "Edge + R2 ready" : health === "checking" ? "Checking deployment" : "Media unavailable"}
        statusState={health}
      />

      <section className="hero section-line shell">
        <div className="eyebrow"><span>Part 1 demo</span> · Protected media delivery</div>
        <h1>One signed request.<br /><em>Every media object protected.</em></h1>
        <p className="hero-copy">
          See a short-lived access token become a bounded playback session at Cloudflare’s edge, while the original HLS package remains private in R2.
        </p>
        <div className="hero-actions">
          <Button className="workers-button primary-action" variant="primary" size="lg" icon={PlayIcon} loading={busy} onClick={runFlow}>
            Run protected playback
          </Button>
          <Button className="workers-button" variant="outline" size="lg" icon={ShieldCheckIcon} onClick={checkDirectAccess}>
            Test unsigned request
          </Button>
        </div>
      </section>

      <section className="architecture section-line shell" aria-labelledby="architecture-title">
        <div className="section-heading">
          <div>
            <span className="section-index">01 / REQUEST PATH</span>
            <h2 id="architecture-title">The exchange at a glance</h2>
          </div>
          <Badge variant="success" appearance="dot">Live Worker</Badge>
        </div>
        <figure className="architecture-diagram">
          <div className="diagram-canvas part1-diagram">
            <section className="diagram-stage">
              <header><span>01</span><div><small>APPLICATION</small><strong>Viewer zone</strong></div></header>
              <div className="diagram-node">
                <VideoCameraIcon />
                <div><strong>Browser + HLS.js</strong><span>Requests playback and follows protected child URIs</span></div>
              </div>
              <div className="diagram-node compact">
                <KeyIcon />
                <div><strong>Token issuer</strong><span>Creates short-lived hdnts</span></div>
              </div>
            </section>

            <div className="diagram-connector"><span>signed request</span></div>

            <section className="diagram-stage edge-stage">
              <header><span>02</span><div><small>CLOUDFLARE EDGE</small><strong>Authorization boundary</strong></div></header>
              <div className="diagram-node emphasis">
                <ShieldCheckIcon />
                <div><strong>Delivery Worker</strong><span>Validates HMAC, ACL, time and optional client IP</span></div>
              </div>
              <div className="diagram-capabilities">
                <span>hdnts → hdntl</span><span>URI rewrite</span><span>private / no-store</span>
              </div>
            </section>

            <div className="diagram-connector"><span>key + object read</span></div>

            <section className="diagram-stage">
              <header><span>03</span><div><small>PRIVATE ORIGIN</small><strong>Cloudflare storage</strong></div></header>
              <div className="diagram-node compact">
                <LockKeyIcon />
                <div><strong>Worker secrets</strong><span>Primary and transition signing keys</span></div>
              </div>
              <div className="diagram-node">
                <DatabaseIcon />
                <div><strong>R2 media bucket</strong><span>Master, renditions and immutable segments remain private</span></div>
              </div>
            </section>
          </div>
          <figcaption className="diagram-sequence">
            <span><b>01</b> Issue hdnts</span>
            <span><b>02</b> Validate at edge</span>
            <span><b>03</b> Read private HLS</span>
            <span><b>04</b> Return hdntl-protected URIs</span>
          </figcaption>
        </figure>
      </section>

      <section className="workbench section-line shell" aria-labelledby="workbench-title">
        <div className="section-heading">
          <div>
            <span className="section-index">02 / INTERACTIVE TRACE</span>
            <h2 id="workbench-title">Inspect each authorization step</h2>
          </div>
          <span className="mono-label">HMAC-SHA256 · R2 · HLS.js</span>
        </div>

        <div className="workbench-grid">
          <div className="control-stack">
            <article className="workers-card controls-card">
              <Brackets />
              <div className="card-head">
                <div className="step-number">01</div>
                <div><h3>Issue access token</h3><p>Simulates an authenticated backend issuer.</p></div>
              </div>
              <label className="field-label" htmlFor="ttl">Access lifetime</label>
              <select id="ttl" value={ttl} onChange={(event) => setTtl(Number(event.target.value))}>
                <option value={60}>60 seconds</option>
                <option value={300}>5 minutes</option>
              </select>
              <Switch className="ip-switch" label="Bind token to client IP" checked={bindIp} onCheckedChange={setBindIp} />
              <Button className="workers-button full" variant="secondary" icon={KeyIcon} onClick={() => void issueToken().catch((caught) => setError(String(caught)))}>
                Generate hdnts
              </Button>
              {access && <div className="result-line"><CheckCircleIcon weight="fill" /><span>Signed · expires in ~{expiresIn}s</span></div>}
            </article>

            <article className="workers-card controls-card">
              <Brackets />
              <div className="card-head">
                <div className="step-number">02</div>
                <div><h3>Exchange at the edge</h3><p>Pulls signing keys, validates fields, then rewrites every URI.</p></div>
              </div>
              <Button className="workers-button full" variant="secondary" icon={LockKeyIcon} disabled={!access} onClick={() => void exchangeToken().catch((caught) => setError(String(caught)))}>
                Request protected manifest
              </Button>
              {sessionToken && <div className="result-line"><CheckCircleIcon weight="fill" /><span>Session issued · URIs rewritten</span></div>}
            </article>
          </div>

          <article className="workers-card player-card">
            <Brackets />
            <div className="player-topline">
              <div><span className="section-index">PROTECTED OUTPUT</span><h3>Browser playback</h3></div>
              <Badge variant={playing ? "success" : sessionPlaybackUrl ? "warning" : "neutral"} appearance="dot">
                {playing ? "Playing" : sessionPlaybackUrl ? "Ready" : "Standby"}
              </Badge>
            </div>
            <div className="video-frame">
              <video ref={videoRef} controls playsInline muted poster="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='1280' height='720'%3E%3Crect width='100%25' height='100%25' fill='%23521000'/%3E%3C/svg%3E" />
              {!playing && (
                <div className="video-empty">
                  {sessionPlaybackUrl ? (
                    <Button className="workers-button video-start" variant="primary" size="lg" icon={PlayIcon} onClick={() => void startPlayback().catch((caught) => setError(String(caught)))}>
                      Start protected stream
                    </Button>
                  ) : (
                    <span><PlayIcon weight="fill" /></span>
                  )}
                  <p>{sessionPlaybackUrl ? "Session ready · playback uses the issued hdntl" : "Complete steps 1 and 2 to enable playback"}</p>
                </div>
              )}
              <div className="live-ribbon"><span /> R2 ORIGIN · EDGE AUTH</div>
            </div>
            <div className="player-metrics">
              <div><strong>{access ? "VALID" : "—"}</strong><span>Access token</span></div>
              <div><strong>{sessionToken ? "BOUND" : "—"}</strong><span>Session token</span></div>
              <div><strong>{manifest ? (manifest.match(/hdntl=/g) ?? []).length : 0}</strong><span>Protected URIs</span></div>
            </div>
          </article>
        </div>
      </section>

      <section className="evidence section-line shell" aria-labelledby="evidence-title">
        <div className="section-heading">
          <div><span className="section-index">03 / EVIDENCE</span><h2 id="evidence-title">What the edge returned</h2></div>
          {directDenied !== null && <Badge variant={directDenied ? "success" : "error"}>{directDenied ? "Unsigned access blocked" : "Protection failed"}</Badge>}
        </div>
        {error && <div className="error-banner"><WarningCircleIcon weight="fill" />{error}</div>}
        <div className="evidence-grid">
          <article className="workers-card token-panel">
            <Brackets />
            <div className="panel-title"><span>hdnts</span><p>Backend-issued access token</p></div>
            {access ? <ClipboardText size="sm" text={access.token} /> : <div className="empty-code">Issue a token to reveal the signed fields.</div>}
            <dl>
              <div><dt>ACL</dt><dd>{access?.claims.acl ?? "—"}</dd></div>
              <div><dt>IP binding</dt><dd>{access?.claims.ip ?? "not requested"}</dd></div>
            </dl>
          </article>
          <article className="workers-card token-panel">
            <Brackets />
            <div className="panel-title"><span>hdntl</span><p>Worker-issued session token</p></div>
            {sessionToken ? <ClipboardText size="sm" text={sessionToken} /> : <div className="empty-code">Exchange hdnts to reveal the bounded session.</div>}
            <dl>
              <div><dt>Shared cache key</dt><dd>viewer auth removed</dd></div>
              <div><dt>Viewer response</dt><dd>private, no-store</dd></div>
            </dl>
          </article>
        </div>
        <article className="manifest-panel">
          <div className="manifest-head"><span>REWRITTEN MASTER PLAYLIST</span><span>{manifest ? "200 · private/no-store" : "waiting"}</span></div>
          <pre>{manifest || "# The original manifest stays in R2.\n# Its child URIs appear here only after edge authorization."}</pre>
        </article>
        <SourceNavigator sessionToken={sessionToken} />
      </section>

      <section className="trace section-line shell">
        <div className="section-heading"><div><span className="section-index">04 / DECISION LOG</span><h2>Browser-side request trace</h2></div><span className="privacy-note">No token values logged</span></div>
        <div className="log-list">
          {logs.map((item, index) => (
            <div className="log-row" key={`${item.time}-${item.label}-${index}`}>
              <span className={`log-state ${item.state}`} />
              <time>{item.time}</time>
              <strong>{item.label}</strong>
              <p>{item.detail}</p>
            </div>
          ))}
        </div>
      </section>

      <footer className="shell">
        <span>Cloudflare Workers + R2</span>
        <span>Reference implementation · not production credentials</span>
      </footer>
    </main>
  );
}
