import { describe, expect, it } from "vitest";
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
});
