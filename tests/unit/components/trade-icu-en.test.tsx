import { describe, expect, it } from "vitest";
import { createTranslator } from "next-intl";
import enMessages from "../../../messages/en.json";

const trEn = createTranslator({ locale: "en", messages: enMessages, namespace: "trade" });

describe("trade ICU plural wording in English (#1799 item 3)", () => {
  it("autoSelectNotice uses the one/other branches", () => {
    expect(trEn("autoSelectNotice", { count: 1 })).toBe(
      "* If you own several copies, your oldest copy is used automatically.",
    );
    expect(trEn("autoSelectNotice", { count: 3 })).toBe(
      "* Your 3 oldest copies are used automatically.",
    );
  });

  it("confirmModalWarning uses the one/other branches", () => {
    expect(trEn("confirmModalWarning", { count: 1 })).toBe(
      "Your oldest copy of the card will be given. Trades cannot be undone.",
    );
    expect(trEn("confirmModalWarning", { count: 3 })).toBe(
      "Your 3 oldest copies of the card will be given. Trades cannot be undone.",
    );
  });

  it("createStep2QuantityOption uses the one/other branches", () => {
    expect(trEn("createStep2QuantityOption", { count: 1 })).toBe("1 copy");
    expect(trEn("createStep2QuantityOption", { count: 3 })).toBe("3 copies");
  });

  it("errorTradeQuantityMismatch renders both quantities without English plural slips", () => {
    expect(trEn("errorTradeQuantityMismatch", { requested: 3, stored: 1 })).toBe(
      "The offer was listed for 1 copy instead of the 3 copies you chose. Please cancel it in My Trades.",
    );
    expect(trEn("errorTradeQuantityMismatch", { requested: 1, stored: 2 })).toBe(
      "The offer was listed for 2 copies instead of the 1 copy you chose. Please cancel it in My Trades.",
    );
  });
});
