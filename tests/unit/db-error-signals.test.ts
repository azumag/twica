import { describe, expect, it } from "vitest";
import { collectErrorSignals } from "@/lib/db/error-signals";

describe("collectErrorSignals", () => {
  it("causeチェーンからcodeとpgのdetailを収集する", () => {
    const error = Object.assign(new Error("Failed query: select card_number from cards"), {
      cause: {
        code: "42703",
        detail: "column card_number does not exist",
      },
    });

    const signals = collectErrorSignals(error);
    expect(signals.codes.has("42703")).toBe(true);
    expect(signals.text).toContain("card_number");
    expect(signals.text).toContain("does not exist");
  });

  it("自己参照するcauseでも停止する", () => {
    const error = Object.assign(new Error("schema cache card_number"), {
      code: "PGRST204",
      cause: undefined as unknown,
    });
    error.cause = error;

    const signals = collectErrorSignals(error);
    expect(signals.codes.has("PGRST204")).toBe(true);
    expect(signals.text).toContain("card_number");
  });

  it("相互参照するcauseでも停止する", () => {
    const first: { message: string; cause?: unknown } = { message: "outer" };
    const second: { code: string; detail: string; cause?: unknown } = {
      code: "42703",
      detail: "column hp does not exist",
    };
    first.cause = second;
    second.cause = first;

    const signals = collectErrorSignals(first);
    expect(signals.codes.has("42703")).toBe(true);
    expect(signals.text).toContain("hp");
  });
});
