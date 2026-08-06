import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { retryAfterSeconds } from "@/lib/rate-limit";

describe("retryAfterSeconds", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reset(epochミリ秒)と現在時刻の差分を秒(整数)に変換する", () => {
    const reset = Date.now() + 60_000;
    expect(retryAfterSeconds(reset)).toBe(60);
  });

  it("端数は切り上げる(59.2秒残 → 60秒)", () => {
    const reset = Date.now() + 59_200;
    expect(retryAfterSeconds(reset)).toBe(60);
  });

  it("1秒未満の正の残り時間は1秒に切り上げる", () => {
    const reset = Date.now() + 500;
    expect(retryAfterSeconds(reset)).toBe(1);
  });

  it("resetが現在時刻と同値の場合は0を返す", () => {
    expect(retryAfterSeconds(Date.now())).toBe(0);
  });

  it("大きな残り時間も秒単位の整数に正しく変換する", () => {
    const reset = Date.now() + 3_600_000;
    expect(retryAfterSeconds(reset)).toBe(3600);
  });

  it("reset未指定時はフォールバック値(fallbackMs、デフォルト60000)を使う", () => {
    expect(retryAfterSeconds()).toBe(60);
    expect(retryAfterSeconds(undefined, 3_600_000)).toBe(3600);
  });

  it("resetが過去の場合は0にクランプする", () => {
    expect(retryAfterSeconds(Date.now() - 5_000)).toBe(0);
  });
});
