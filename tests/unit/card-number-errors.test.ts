import { describe, expect, it } from "vitest";
import { isCardNumberConflictError, isMissingCardNumberColumnError } from "@/lib/card-number-errors";

describe("card-number-errors", () => {
  it("detects card number unique constraint violations", () => {
    expect(isCardNumberConflictError({
      code: "23505",
      message: "duplicate key value violates unique constraint \"cards_streamer_card_number_unique\"",
    })).toBe(true);
  });

  it("ignores unrelated database errors", () => {
    expect(isCardNumberConflictError({
      code: "23505",
      message: "duplicate key value violates unique constraint \"other_constraint\"",
    })).toBe(false);
    expect(isCardNumberConflictError({ code: "42P01", message: "relation missing" })).toBe(false);
  });
});

describe("isMissingCardNumberColumnError", () => {
  it("detects PostgREST schema-cache errors for cards.card_number", () => {
    expect(isMissingCardNumberColumnError({
      code: "PGRST204",
      message: "Could not find the 'card_number' column of 'cards' in the schema cache",
    })).toBe(true);
  });

  it("ignores unrelated missing-column errors", () => {
    expect(isMissingCardNumberColumnError({
      code: "PGRST204",
      message: "Could not find the 'other_column' column of 'cards' in the schema cache",
    })).toBe(false);
  });
});
