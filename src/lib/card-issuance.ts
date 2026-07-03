export const CARD_ISSUANCE_MESSAGES = {
  invalid: "発行可能枚数は1以上の整数、または空欄で入力してください",
  soldOut: "このカードは発行可能枚数に達しています",
} as const;

export function parseCardIssuanceLimit(value: unknown): number | null | "invalid" {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return "invalid";
  }
  return value;
}

export function isMissingCardIssuanceColumnError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const err = error as { code?: unknown; message?: unknown; details?: unknown; hint?: unknown };
  const text = [
    err.message,
    err.details,
    err.hint,
  ].map((value) => String(value || "")).join(" ");

  return text.includes("max_issuance_count") && (
    text.includes("schema cache") ||
    text.includes("column") ||
    err.code === "PGRST204"
  );
}
