import { useEffect, useState } from "react";
import { Badge } from "@cloudflare/kumo/components/badge";
import {
  FileTextIcon,
  FilmStripIcon,
  FolderIcon,
  TreeStructureIcon,
} from "@phosphor-icons/react";
import { maskSessionToken } from "./demo-helpers";

type SourceObject = {
  key: string;
  size: number;
  etag: string;
  uploaded: string;
  contentType?: string;
};

type TreeRow = {
  key: string;
  label: string;
  depth: number;
  type: "folder" | "playlist" | "media";
  object?: SourceObject;
};

function buildRows(objects: SourceObject[]): TreeRow[] {
  const folders = new Set<string>();
  for (const object of objects) {
    const parts = object.key.split("/");
    for (let index = 1; index < parts.length; index += 1) folders.add(parts.slice(0, index).join("/"));
  }
  const rows: TreeRow[] = [
    ...[...folders].map((key) => {
      const parts = key.split("/");
      return {
        key: `${key}/`,
        label: parts.at(-1) ?? key,
        depth: parts.length - 1,
        type: "folder" as const,
      };
    }),
    ...objects.map((object) => {
      const parts = object.key.split("/");
      return {
        key: object.key,
        label: parts.at(-1) ?? object.key,
        depth: parts.length - 1,
        type: object.key.endsWith(".m3u8") ? "playlist" as const : "media" as const,
        object,
      };
    }),
  ];
  return rows.sort((left, right) => left.key.localeCompare(right.key));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export function SourceNavigator({ sessionToken }: { sessionToken: string }) {
  const [objects, setObjects] = useState<SourceObject[]>([]);
  const [selected, setSelected] = useState("demo/master.m3u8");
  const [canonical, setCanonical] = useState("");
  const [viewer, setViewer] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    fetch("/api/source/tree")
      .then(async (response) => {
        if (!response.ok) throw new Error("Unable to list the R2 source package");
        const body = await response.json() as { objects: SourceObject[] };
        setObjects(body.objects);
      })
      .catch((caught) => setError(errorMessage(caught)));
  }, []);

  useEffect(() => {
    if (!selected.endsWith(".m3u8")) return;
    const controller = new AbortController();
    setError("");
    setCanonical("");
    setViewer("");
    fetch(`/api/source/file?key=${encodeURIComponent(selected)}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("Unable to read the canonical playlist");
        const body = await response.json() as { content: string };
        setCanonical(body.content);
      })
      .catch((caught) => {
        if (!isAbortError(caught)) setError(errorMessage(caught));
      });
    if (sessionToken) {
      const mediaPath = `/media/${selected}`;
      fetch(`${mediaPath}?hdntl=${encodeURIComponent(sessionToken)}`, { signal: controller.signal })
        .then(async (response) => {
          const body = await response.text();
          if (!response.ok) throw new Error(body || "Edge rewrite failed");
          setViewer(maskSessionToken(body));
        })
        .catch((caught) => {
          if (!isAbortError(caught)) setError(errorMessage(caught));
        });
    }
    return () => controller.abort();
  }, [selected, sessionToken]);

  const rows = buildRows(objects);
  const selectedObject = objects.find((object) => object.key === selected);

  return (
    <article className="source-browser workers-card">
      <div className="source-browser-head">
        <div>
          <span className="section-index">R2 SOURCE INSPECTOR</span>
          <h3>Canonical object vs. viewer response</h3>
        </div>
        <Badge variant={sessionToken ? "success" : "neutral"} appearance="dot">
          {sessionToken ? "Rewrite available" : "Exchange token to compare"}
        </Badge>
      </div>
      {error && <p className="source-error">{error}</p>}
      <div className="source-browser-grid">
        <nav className="object-tree" aria-label="R2 source package">
          <div className="tree-title"><TreeStructureIcon /> private://media/demo</div>
          {rows.map((row) => {
            const Icon = row.type === "folder" ? FolderIcon : row.type === "playlist" ? FileTextIcon : FilmStripIcon;
            const selectable = row.type === "playlist";
            return (
              <button
                type="button"
                className={`tree-row ${selected === row.key ? "selected" : ""} ${selectable ? "selectable" : ""}`}
                style={{ paddingLeft: `${14 + row.depth * 16}px` }}
                key={row.key}
                disabled={!selectable}
                onClick={() => setSelected(row.key)}
              >
                <Icon weight={row.type === "folder" ? "fill" : "regular"} />
                <span>{row.label}</span>
                {row.object && <small>{Math.max(1, Math.round(row.object.size / 1024))} KB</small>}
              </button>
            );
          })}
        </nav>
        <div className="manifest-compare">
          <div className="compare-meta">
            <span>{selected}</span>
            <span>{selectedObject?.etag.slice(0, 12) ?? "loading"}</span>
          </div>
          <div className="compare-columns">
            <section>
              <header><span>01</span><strong>Canonical in R2</strong><small>No viewer token stored</small></header>
              <pre>{canonical || "# Loading canonical object..."}</pre>
            </section>
            <section className="viewer-copy">
              <header><span>02</span><strong>Edge viewer response</strong><small>hdntl injected in memory</small></header>
              <pre>{viewer || "# Complete the token exchange above.\n# The selected playlist will be fetched through the delivery Worker."}</pre>
            </section>
          </div>
        </div>
      </div>
    </article>
  );
}
