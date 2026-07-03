import { describe, expect, it } from "vitest"

import { isEnterKeySubmit } from "@/lib/keyboard-utils"

// Issue #613: IME(日本語入力等)の変換確定Enterを、追加/保存の送信操作として
// 誤検知しないための判定関数。CardPackModal / CustomRarityModal の複数箇所で
// 共有される単純な述語なので、コンポーネントを介さず直接検証する。
describe("isEnterKeySubmit", () => {
  it("returns true for a normal (non-composing) Enter key press", () => {
    expect(
      isEnterKeySubmit({ key: "Enter", nativeEvent: { isComposing: false } })
    ).toBe(true)
  })

  it("returns false for an Enter key press while IME composition is active", () => {
    expect(
      isEnterKeySubmit({ key: "Enter", nativeEvent: { isComposing: true } })
    ).toBe(false)
  })

  it("returns false for non-Enter keys regardless of composition state", () => {
    expect(
      isEnterKeySubmit({ key: "a", nativeEvent: { isComposing: false } })
    ).toBe(false)
    expect(
      isEnterKeySubmit({ key: "Escape", nativeEvent: { isComposing: true } })
    ).toBe(false)
  })
})
