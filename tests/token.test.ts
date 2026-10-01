import { describe, expect, it } from "vitest";
import { signToken, verifyToken } from "../src/token";

const primary = "primary-test-secret";
const transition = "transition-test-secret";
const now = 1_800_000_000;

describe("signed tokens", () => {
  it("preserves the public token field order and signature encoding", async () => {
    await expect(signToken({
      st: now - 5,
      exp: now + 300,
      acl: "/media/demo/*",
      id: "viewer-1",
    }, primary)).resolves.toBe(
      "st=1799999995~exp=1800000300~acl=/media/demo/*~id=viewer-1~hmac=d4fd05e31ccaa1196b97c189a9689994c5ea7c5dee2c55109c2f812ff4cf1578",
    );
  });

  it("accepts a valid primary token", async () => {
    const token = await signToken({ st: now - 5, exp: now + 300, acl: "/media/demo/*", id: "viewer-1" }, primary);
    const claims = await verifyToken(token, [primary, transition], {
      path: "/media/demo/master.m3u8",
      now,
      maxLifetimeSeconds: 600,
    });

    expect(claims.id).toBe("viewer-1");
    expect(claims.keyIndex).toBe(0);
  });

  it("accepts a transition-key token", async () => {
    const token = await signToken({ st: now - 5, exp: now + 300, acl: "/media/demo/*" }, transition);
    const claims = await verifyToken(token, [primary, transition], {
      path: "/media/demo/720p/segment-001.ts",
      now,
      maxLifetimeSeconds: 600,
    });

    expect(claims.keyIndex).toBe(1);
  });

  it("rejects tampering, expired tokens, ACL misses, and IP mismatches", async () => {
    const valid = await signToken({ st: now - 5, exp: now + 60, acl: "/media/demo/*", ip: "192.0.2.1" }, primary);
    const base = { path: "/media/demo/master.m3u8", now, maxLifetimeSeconds: 600, ip: "192.0.2.1" };

    await expect(verifyToken(valid.replace("exp=1800000060", "exp=1800000500"), [primary], base)).rejects.toMatchObject({ code: "signature" });
    await expect(verifyToken(valid, [primary], { ...base, now: now + 100 })).rejects.toMatchObject({ code: "expired" });
    await expect(verifyToken(valid, [primary], { ...base, path: "/media/other/master.m3u8" })).rejects.toMatchObject({ code: "acl" });
    await expect(verifyToken(valid, [primary], { ...base, ip: "192.0.2.2" })).rejects.toMatchObject({ code: "ip" });
  });

  it("rejects duplicate fields", async () => {
    const token = await signToken({ st: now - 5, exp: now + 60, acl: "/media/demo/*" }, primary);
    const duplicate = token.replace("~exp=", `~st=${now - 5}~exp=`);
    await expect(verifyToken(duplicate, [primary], {
      path: "/media/demo/master.m3u8",
      now,
      maxLifetimeSeconds: 600,
    })).rejects.toMatchObject({ code: "malformed" });
  });
});
