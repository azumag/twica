function segmentCharacters(text: string): string[] {
  if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
    return Array.from(
      new Intl.Segmenter("ja", { granularity: "grapheme" }).segment(text)
    ).map((segment) => segment.segment);
  }

  return Array.from(text);
}

export function countCharacters(text: string): number {
  return segmentCharacters(text).length;
}

export function truncateCharacters(text: string, maxCharacters: number): string {
  if (maxCharacters <= 0) {
    return "";
  }

  const segments = segmentCharacters(text);
  if (segments.length <= maxCharacters) {
    return text;
  }

  return segments.slice(0, maxCharacters).join("");
}
