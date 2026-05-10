export const CARD_MEDIA_TYPES = ["image", "video"] as const;

export type CardMediaType = (typeof CARD_MEDIA_TYPES)[number];

export function normalizeCardMediaType(mediaType: unknown): CardMediaType {
  return mediaType === "video" ? "video" : "image";
}

export function isVideoCard(mediaType: unknown): boolean {
  return normalizeCardMediaType(mediaType) === "video";
}

export function isMissingCardMediaTypeColumnError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const message = "message" in error ? String((error as { message?: unknown }).message ?? "") : "";
  const details = "details" in error ? String((error as { details?: unknown }).details ?? "") : "";
  const hint = "hint" in error ? String((error as { hint?: unknown }).hint ?? "") : "";
  const text = `${message} ${details} ${hint}`;
  return text.includes("media_type") && (
    text.includes("schema cache") ||
    text.includes("Could not find") ||
    text.includes("column")
  );
}
