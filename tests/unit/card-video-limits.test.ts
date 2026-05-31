import { describe, expect, it } from "vitest";
import { getVideoCardLimit } from "@/lib/card-video-limits";

describe("card video limits", () => {
  it("keeps a small free video-card allowance and expands paid plans", () => {
    expect(getVideoCardLimit("basic")).toBe(3);
    expect(getVideoCardLimit("support")).toBeGreaterThan(getVideoCardLimit("basic"));
    expect(getVideoCardLimit("patron")).toBeGreaterThan(getVideoCardLimit("support"));
    expect(getVideoCardLimit("twitch_sub")).toBe(getVideoCardLimit("patron"));
  });
});
