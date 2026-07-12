import { describe, expect, it } from "vitest";
import { hasInvalidOverlayEventsStreamerId } from "@/lib/overlay-route-validation";

describe("hasInvalidOverlayEventsStreamerId", () => {
  const validStreamerId = "94cb6927-8733-4f1c-8e7e-0afb89773daa";

  it("accepts a canonical UUID on the overlay events API path", () => {
    expect(
      hasInvalidOverlayEventsStreamerId(
        `/api/overlay/${validStreamerId}/events`
      )
    ).toBe(false);
  });

  it("accepts a trailing slash", () => {
    expect(
      hasInvalidOverlayEventsStreamerId(
        `/api/overlay/${validStreamerId}/events/`
      )
    ).toBe(false);
  });

  it("rejects a UUID with an appended string (Issue #657)", () => {
    expect(
      hasInvalidOverlayEventsStreamerId(
        `/api/overlay/${validStreamerId}source/events`
      )
    ).toBe(true);
  });

  it("rejects a non-UUID streamer ID", () => {
    expect(
      hasInvalidOverlayEventsStreamerId("/api/overlay/streamer-1/events")
    ).toBe(true);
  });

  it("does not validate unrelated paths", () => {
    expect(
      hasInvalidOverlayEventsStreamerId(
        `/overlay/${validStreamerId}`
      )
    ).toBe(false);
    expect(
      hasInvalidOverlayEventsStreamerId(
        `/api/overlay/${validStreamerId}/events/extra`
      )
    ).toBe(false);
  });
});
