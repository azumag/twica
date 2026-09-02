import { describe, expect, it } from "vitest";
import enMessages from "../../messages/en.json";
import jaMessages from "../../messages/ja.json";

describe("channelPointSettings.buttons.creating", () => {
  it("作成処理中ラベルを日本語・英語の双方で定義する", () => {
    expect(jaMessages.channelPointSettings.buttons.creating).toBe("作成中...");
    expect(enMessages.channelPointSettings.buttons.creating).toBe("Creating...");
  });
});
