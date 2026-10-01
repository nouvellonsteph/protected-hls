import { describe, expect, it } from "vitest";
import { projectLivePlaylist, rewritePlaylist, tailMediaPlaylist } from "../src/hls";
import { canonicalizeMediaPlaylist } from "../src/part2";

describe("HLS rewriting", () => {
  it("protects URI lines and every supported URI attribute", () => {
    const source = `#EXTM3U
#EXT-X-DEFINE:NAME="variant",VALUE="720p"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",URI="audio/index.m3u8?lang=en"
#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=80000,URI="iframes.m3u8"
#EXT-X-KEY:METHOD=AES-128,URI="keys/key.bin"
#EXT-X-MAP:URI="init.mp4"
#EXT-X-PART:DURATION=0.5,URI="parts/part-1.m4s"
#EXT-X-PRELOAD-HINT:TYPE=PART,URI="parts/part-2.m4s"
#EXT-X-RENDITION-REPORT:URI="../{$variant}/index.m3u8",LAST-MSN=4
#EXTINF:2,
segment-001.ts?quality=high#fragment`;

    const output = rewritePlaylist(source, new URL("https://demo.example/media/demo/master.m3u8?hdnts=old"), "session-token");

    expect(output.match(/hdntl=session-token/g)).toHaveLength(8);
    expect(output).toContain("/media/demo/audio/index.m3u8?lang=en&hdntl=session-token");
    expect(output).toContain("/media/720p/index.m3u8?hdntl=session-token");
    expect(output).toContain("/media/demo/segment-001.ts?quality=high&hdntl=session-token#fragment");
    expect(output).not.toContain("hdnts=");
  });

  it("fails closed for cross-origin and unknown URI-bearing tags", () => {
    expect(() => rewritePlaylist("#EXTM3U\nhttps://other.example/segment.ts", new URL("https://demo.example/media/demo/master.m3u8"), "token"))
      .toThrow("Cross-origin");
    expect(() => rewritePlaylist("#EXTM3U\n#EXT-X-FUTURE:URI=\"object.bin\"", new URL("https://demo.example/media/demo/master.m3u8"), "token"))
      .toThrow("Unsupported URI-bearing");
  });

  it("turns an ingest playlist into source-qualified canonical R2 paths", () => {
    const source = `#EXTM3U
#EXT-X-KEY:METHOD=AES-128,URI="key.bin"
#EXTINF:2,
segment-001.ts
#EXTINF:2,
segment-002.ts`;
    const output = canonicalizeMediaPlaylist(source, "live/sources/primary/event-1/360p");

    expect(output.manifest).toContain('/media/live/sources/primary/event-1/360p/key.bin');
    expect(output.manifest).toContain("/media/live/sources/primary/event-1/360p/segment-001.ts");
    expect(output.objectNames).toEqual(["key.bin", "segment-001.ts", "segment-002.ts"]);
  });

  it("rejects ingest playlist references outside the rendition namespace", () => {
    expect(() => canonicalizeMediaPlaylist("#EXTM3U\n../segment.ts", "live/sources/primary/event-1/360p"))
      .toThrow("escapes the source rendition");
  });

  it("keeps primary and backup media paths isolated behind the canonical playlist", () => {
    const playlist = "#EXTM3U\n#EXTINF:2,\nsegment-001.ts\n";
    const primary = canonicalizeMediaPlaylist(playlist, "live/sources/primary/event-1/360p");
    const backup = canonicalizeMediaPlaylist(playlist, "live/sources/backup/event-1/360p");

    expect(primary.manifest).toContain("/media/live/sources/primary/event-1/360p/segment-001.ts");
    expect(backup.manifest).toContain("/media/live/sources/backup/event-1/360p/segment-001.ts");
  });

  it("tails live playlists and advances their media sequence", () => {
    const source = `#EXTM3U
#EXT-X-MEDIA-SEQUENCE:10
#EXT-X-TARGETDURATION:2
#EXTINF:2,
segment-010.ts
#EXTINF:2,
segment-011.ts
#EXTINF:2,
segment-012.ts`;

    expect(tailMediaPlaylist(source, 2)).toBe(`#EXTM3U
#EXT-X-MEDIA-SEQUENCE:11
#EXT-X-TARGETDURATION:2
#EXTINF:2,
segment-011.ts
#EXTINF:2,
segment-012.ts
`);
    expect(tailMediaPlaylist(source, 3)).toBe(`${source}\n`);
  });

  it("projects a finite media package as an advancing timestamped live window", () => {
    const source = `#EXTM3U
#EXT-X-TARGETDURATION:2
#EXT-X-PLAYLIST-TYPE:VOD
#EXTINF:2.0,
segment-000.ts
#EXTINF:2.0,
segment-001.ts
#EXT-X-ENDLIST`;
    const output = projectLivePlaylist(source, 20_000, 4);

    expect(output).toContain("#EXT-X-MEDIA-SEQUENCE:7");
    expect(output).toContain("#EXT-X-PROGRAM-DATE-TIME:1970-01-01T00:00:14.000Z");
    expect(output).toContain("segment-000.ts?live_seq=10");
    expect(output).toContain("#EXT-X-DISCONTINUITY");
    expect(output).not.toContain("PLAYLIST-TYPE:VOD");
    expect(output).not.toContain("#EXT-X-ENDLIST");
  });
});
