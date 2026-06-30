import { describe, expect, it } from "vitest";
import {
  normalizeCollectionName,
  resolveCollectionNameField,
  MAX_COLLECTION_NAME_LENGTH,
} from "@/lib/validation/collection-name";

describe("normalizeCollectionName", () => {
  it("returns undefined for omitted/invalid-type inputs", () => {
    expect(normalizeCollectionName(undefined)).toBeUndefined();
    expect(normalizeCollectionName(123)).toBeUndefined();
    expect(normalizeCollectionName({})).toBeUndefined();
    expect(normalizeCollectionName([])).toBeUndefined();
    expect(normalizeCollectionName(true)).toBeUndefined();
  });

  it("returns null for explicit null and blank strings", () => {
    expect(normalizeCollectionName(null)).toBeNull();
    expect(normalizeCollectionName("")).toBeNull();
    expect(normalizeCollectionName("   ")).toBeNull();
    expect(normalizeCollectionName("\t\n")).toBeNull();
  });

  it("trims and returns non-empty names", () => {
    expect(normalizeCollectionName("weapons")).toBe("weapons");
    expect(normalizeCollectionName("  characters  ")).toBe("characters");
  });

  it("does NOT case-fold or NFC-normalize (distinct packs are kept distinct)", () => {
    expect(normalizeCollectionName("Pokemon")).toBe("Pokemon");
    expect(normalizeCollectionName("pokemon")).toBe("pokemon");
  });

  it("preserves over-length names (length is enforced by resolveCollectionNameField)", () => {
    const long = "a".repeat(MAX_COLLECTION_NAME_LENGTH + 1);
    expect(normalizeCollectionName(long)).toBe(long);
  });
});

describe("resolveCollectionNameField", () => {
  it("treats an absent property as 'undefined' (skip column), not an error", () => {
    const result = resolveCollectionNameField({}, "collectionName");
    expect(result).toEqual({ ok: true, value: undefined });
  });

  it("treats null / blank as an explicit clear (null)", () => {
    expect(resolveCollectionNameField({ collectionName: null }, "collectionName")).toEqual({
      ok: true,
      value: null,
    });
    expect(resolveCollectionNameField({ collectionName: "" }, "collectionName")).toEqual({
      ok: true,
      value: null,
    });
    expect(resolveCollectionNameField({ collectionName: "   " }, "collectionName")).toEqual({
      ok: true,
      value: null,
    });
  });

  it("returns a trimmed value for valid names", () => {
    expect(resolveCollectionNameField({ collectionName: "  weapons " }, "collectionName")).toEqual({
      ok: true,
      value: "weapons",
    });
  });

  it("rejects a present-but-invalid type (must not be silently ignored)", () => {
    expect(resolveCollectionNameField({ collectionName: 123 }, "collectionName")).toEqual({
      ok: false,
    });
    expect(resolveCollectionNameField({ collectionName: {} }, "collectionName")).toEqual({
      ok: false,
    });
  });

  it("rejects names longer than the max length", () => {
    const long = "a".repeat(MAX_COLLECTION_NAME_LENGTH + 1);
    expect(resolveCollectionNameField({ collectionName: long }, "collectionName")).toEqual({
      ok: false,
    });
  });

  it("accepts a name exactly at the max length", () => {
    const exact = "a".repeat(MAX_COLLECTION_NAME_LENGTH);
    expect(resolveCollectionNameField({ collectionName: exact }, "collectionName")).toEqual({
      ok: true,
      value: exact,
    });
  });

  it("uses property presence (Object.hasOwn), not truthiness, to detect provided fields", () => {
    // `collectionName: ""` is falsy but present → resolves to null (clear), not undefined.
    const result = resolveCollectionNameField({ collectionName: "" }, "collectionName");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBeNull();
  });
});
