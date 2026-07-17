import { collectErrorSignals } from "@/lib/db/error-signals";

export const CARD_NUMBER_MESSAGES = {
  duplicate: "このカード番号はすでに別のカードで使われています。",
  invalid: "カード番号は1以上の整数で入力してください。",
} as const;

export function isCardNumberConflictError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { codes, text } = collectErrorSignals(error);
  if (!codes.has("23505")) return false;

  return text.includes("cards_streamer_card_number_unique") || text.includes("card_number");
}

export function isMissingCardNumberColumnError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { codes, text } = collectErrorSignals(error);

  return text.includes("card_number") && (
    text.includes("schema cache") ||
    text.includes("column") ||
    codes.has("PGRST204") ||
    codes.has("42703")
  );
}
