import { describe, expect, it } from "vitest"

import { isAllowedCardUploadFile, shouldPreserveOriginalCardUpload } from "@/lib/card-upload-mode"

describe("shouldPreserveOriginalCardUpload", () => {
  it("preserves GIF uploads so animation is not flattened by crop canvas", () => {
    expect(shouldPreserveOriginalCardUpload({
      name: "card.gif",
      type: "image/gif",
    })).toBe(true)
  })

  it("preserves GIF uploads when the browser omits the MIME type", () => {
    expect(shouldPreserveOriginalCardUpload({
      name: "card.GIF",
      type: "",
    })).toBe(true)
  })

  it("uses the crop flow for static image formats", () => {
    expect(shouldPreserveOriginalCardUpload({
      name: "card.webp",
      type: "image/webp",
    })).toBe(false)
  })
})

describe("isAllowedCardUploadFile", () => {
  it("allows known image MIME types", () => {
    expect(isAllowedCardUploadFile({
      name: "card.webp",
      type: "image/webp",
    })).toBe(true)
  })

  it("allows a known extension when the browser omits the MIME type", () => {
    expect(isAllowedCardUploadFile({
      name: "card.gif",
      type: "",
    })).toBe(true)
  })

  it("rejects unknown files when the MIME type is missing", () => {
    expect(isAllowedCardUploadFile({
      name: "card.txt",
      type: "",
    })).toBe(false)
  })
})
