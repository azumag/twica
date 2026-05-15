export const CARD_MEDIA_TYPES = ["image", "video"] as const;

export type CardMediaType = (typeof CARD_MEDIA_TYPES)[number];

export function normalizeCardMediaType(mediaType: unknown): CardMediaType {
  return mediaType === "video" ? "video" : "image";
}

export function isVideoCard(mediaType: unknown): boolean {
  return normalizeCardMediaType(mediaType) === "video";
}

