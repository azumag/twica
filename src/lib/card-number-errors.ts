export const CARD_NUMBER_MESSAGES = {
  duplicate: "このカード番号はすでに別のカードで使われています。",
  invalid: "カード番号は1以上の整数で入力してください。",
} as const;

export function isCardNumberConflictError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const err = error as { code?: unknown; message?: unknown; details?: unknown };
  if (err.code !== "23505") return false;

  const text = `${String(err.message || "")} ${String(err.details || "")}`;
  return text.includes("cards_streamer_card_number_unique") || text.includes("card_number");
}
