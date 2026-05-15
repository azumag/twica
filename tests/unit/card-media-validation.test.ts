import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateCardMediaType, validateCardMediaUrl } from "@/lib/validations";

describe("card media validation", () => {
  it("accepts existing image URL formats for image cards", () => {
    expect(validateCardMediaUrl("https://example.com/card.webp", "image")).toEqual({ valid: true });
  });

  it("accepts HTTPS video URLs with supported extensions for video cards", () => {
    expect(validateCardMediaUrl("https://cdn.example.com/cards/intro.webm", "video")).toEqual({ valid: true });
    expect(validateCardMediaUrl("https://cdn.example.com/cards/intro.mp4", "video")).toEqual({ valid: true });
  });

  it("rejects empty or non-video URLs for video cards", () => {
    expect(validateCardMediaUrl("", "video").valid).toBe(false);
    expect(validateCardMediaUrl("http://example.com/card.mp4", "video").valid).toBe(false);
    expect(validateCardMediaUrl("https://example.com/card.png", "video").valid).toBe(false);
  });

  it("validates media type values", () => {
    expect(validateCardMediaType("image")).toEqual({ valid: true });
    expect(validateCardMediaType("video")).toEqual({ valid: true });
    expect(validateCardMediaType("audio").valid).toBe(false);
  });

  describe("video URL host allowlist", () => {
    const ORIGINAL = process.env.ALLOWED_VIDEO_HOSTS;

    beforeEach(() => {
      delete process.env.ALLOWED_VIDEO_HOSTS;
    });

    afterEach(() => {
      if (ORIGINAL === undefined) {
        delete process.env.ALLOWED_VIDEO_HOSTS;
      } else {
        process.env.ALLOWED_VIDEO_HOSTS = ORIGINAL;
      }
    });

    it("permits any HTTPS host when ALLOWED_VIDEO_HOSTS is not set (back-compat)", () => {
      expect(validateCardMediaUrl("https://random-cdn.example.com/x.mp4", "video")).toEqual({ valid: true });
    });

    it("rejects hosts outside allowlist when ALLOWED_VIDEO_HOSTS is set", () => {
      process.env.ALLOWED_VIDEO_HOSTS = "trusted.example.com,pub-abc.r2.dev";
      expect(validateCardMediaUrl("https://attacker.com/x.mp4", "video").valid).toBe(false);
    });

    it("accepts hosts that exactly match an allowlist entry", () => {
      process.env.ALLOWED_VIDEO_HOSTS = "trusted.example.com";
      expect(validateCardMediaUrl("https://trusted.example.com/x.mp4", "video")).toEqual({ valid: true });
    });

    it("accepts subdomains of allowlist entries", () => {
      process.env.ALLOWED_VIDEO_HOSTS = "example.com";
      expect(validateCardMediaUrl("https://cdn.example.com/x.mp4", "video")).toEqual({ valid: true });
    });

    it("ignores empty whitespace entries in the allowlist", () => {
      process.env.ALLOWED_VIDEO_HOSTS = " ,trusted.example.com, ";
      expect(validateCardMediaUrl("https://trusted.example.com/x.mp4", "video")).toEqual({ valid: true });
      expect(validateCardMediaUrl("https://other.example.com/x.mp4", "video").valid).toBe(false);
    });
  });
});
