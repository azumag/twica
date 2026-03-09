export function countCharacters(text: string): number {
  if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
    return Array.from(
      new Intl.Segmenter("ja", { granularity: "grapheme" }).segment(text)
    ).length;
  }

  return Array.from(text).length;
}
