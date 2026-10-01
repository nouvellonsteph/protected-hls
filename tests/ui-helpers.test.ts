import { describe, expect, it } from "vitest";
import { isPart2Path, maskSessionToken } from "../ui/src/demo-helpers";

describe("UI helpers", () => {
  it("preserves the existing Part 2 path matching", () => {
    expect(isPart2Path("/part-2/")).toBe(true);
    expect(isPart2Path("/part-20")).toBe(true);
    expect(isPart2Path("/part-1/")).toBe(false);
  });

  it("masks session tokens without changing surrounding playlist text", () => {
    const manifest = "segment.ts?quality=high&hdntl=secret-1&part=2\nkey.bin?hdntl=secret-2\n";
    expect(maskSessionToken(manifest)).toBe(
      "segment.ts?quality=high&hdntl=<session-token>&part=2\nkey.bin?hdntl=<session-token>\n",
    );
  });
});
