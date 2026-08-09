import { describe, it, expect } from "vitest";
import {
  shouldScheduleReload,
  isReloadCooldownActive,
  serializePollState,
  parsePollState,
  parseReloadCooldownRecord,
  RELOAD_COOLDOWN_MS,
  POLLSTATE_TTL_MS,
  MAX_PERSISTED_HISTORY_IDS,
} from "@/lib/overlay-version";

// Issue #569: overlay のバージョン不一致検出＋アイドル時自動リロード機構の
// 純粋関数群のユニットテスト。sessionStorageやタイマーには一切依存せず、
// 全て引数として値を注入してテストする。

const historyUuid = (index: number) =>
  `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;

describe("shouldScheduleReload", () => {
  it("current/receivedが異なればtrueを返す", () => {
    expect(shouldScheduleReload("abc123def456", "def456abc789")).toBe(true);
  });

  it("current/receivedが同じならfalseを返す(リロード不要)", () => {
    expect(shouldScheduleReload("abc123def456", "abc123def456")).toBe(false);
  });

  it("receivedがundefinedならfalseを返す(判定不能)", () => {
    expect(shouldScheduleReload("abc123def456", undefined)).toBe(false);
  });

  it("receivedが空文字列ならfalseを返す(判定不能)", () => {
    expect(shouldScheduleReload("abc123def456", "")).toBe(false);
  });

  it("currentが空文字列ならfalseを返す(判定不能)", () => {
    expect(shouldScheduleReload("", "abc123def456")).toBe(false);
  });

  it("currentが'dev'ならreceivedと異なっていてもfalseを返す(dev環境はスキップ)", () => {
    expect(shouldScheduleReload("dev", "abc123def456")).toBe(false);
  });

  it("receivedが'dev'ならcurrentと異なっていてもfalseを返す(dev環境はスキップ)", () => {
    expect(shouldScheduleReload("abc123def456", "dev")).toBe(false);
  });

  it("current/receivedが両方'dev'でもfalseを返す", () => {
    expect(shouldScheduleReload("dev", "dev")).toBe(false);
  });
});

describe("isReloadCooldownActive", () => {
  it("recordがnull(未リロード)ならfalseを返す", () => {
    expect(isReloadCooldownActive(null, "v2", 100000, RELOAD_COOLDOWN_MS)).toBe(false);
  });

  it("recordのバージョンがtargetVersionと異なればfalseを返す(別バージョンは独立してカウント)", () => {
    const record = { version: "v1", reloadedAt: 100000 };
    expect(isReloadCooldownActive(record, "v2", 100000 + 1000, RELOAD_COOLDOWN_MS)).toBe(false);
  });

  it("同一バージョンでcooldownMs未満ならtrueを返す(クールダウン中)", () => {
    const record = { version: "v2", reloadedAt: 100000 };
    const now = 100000 + RELOAD_COOLDOWN_MS - 1;
    expect(isReloadCooldownActive(record, "v2", now, RELOAD_COOLDOWN_MS)).toBe(true);
  });

  it("同一バージョンでちょうどcooldownMs経過した境界ではfalseを返す(クールダウン明け)", () => {
    const record = { version: "v2", reloadedAt: 100000 };
    const now = 100000 + RELOAD_COOLDOWN_MS;
    expect(isReloadCooldownActive(record, "v2", now, RELOAD_COOLDOWN_MS)).toBe(false);
  });

  it("同一バージョンでcooldownMsを超えて経過していればfalseを返す", () => {
    const record = { version: "v2", reloadedAt: 100000 };
    const now = 100000 + RELOAD_COOLDOWN_MS + 1;
    expect(isReloadCooldownActive(record, "v2", now, RELOAD_COOLDOWN_MS)).toBe(false);
  });

  it("ロールバック相当のシナリオ: 旧バージョンへ戻る場合は直前の記録と別バージョン扱いになり即座にリロード可能", () => {
    // v1(現行) -> v2(新版)へリロード済みの直後に、本番がv1へロールバックされたケース。
    // v1向けのクールダウン記録はまだ無い(前回はv2への記録のみ)ため、
    // v1への再リロードはクールダウンの影響を受けない。
    const record = { version: "v2", reloadedAt: 100000 };
    const now = 100000 + 1000; // v2へのクールダウン期間内
    expect(isReloadCooldownActive(record, "v1", now, RELOAD_COOLDOWN_MS)).toBe(false);
  });
});

describe("parseReloadCooldownRecord", () => {
  it("正当なJSONを{version, reloadedAt}として復元する", () => {
    const raw = JSON.stringify({ version: "v2", reloadedAt: 12345 });
    expect(parseReloadCooldownRecord(raw)).toEqual({ version: "v2", reloadedAt: 12345 });
  });

  it("rawがnull/undefined/空文字列ならnullを返す", () => {
    expect(parseReloadCooldownRecord(null)).toBeNull();
    expect(parseReloadCooldownRecord(undefined)).toBeNull();
    expect(parseReloadCooldownRecord("")).toBeNull();
  });

  it("JSONとしてparseできない壊れた文字列でも例外を投げずnullを返す", () => {
    expect(() => parseReloadCooldownRecord("{broken")).not.toThrow();
    expect(parseReloadCooldownRecord("{broken")).toBeNull();
  });

  it("JSONとして正当だがオブジェクトでない場合はnullを返す", () => {
    expect(parseReloadCooldownRecord("42")).toBeNull();
    expect(parseReloadCooldownRecord("null")).toBeNull();
    expect(parseReloadCooldownRecord('"v2"')).toBeNull();
  });

  it("versionが欠けている/文字列でない場合はnullを返す", () => {
    expect(parseReloadCooldownRecord(JSON.stringify({ reloadedAt: 1 }))).toBeNull();
    expect(parseReloadCooldownRecord(JSON.stringify({ version: 123, reloadedAt: 1 }))).toBeNull();
  });

  it("reloadedAtが欠けている/数値でない場合はnullを返す", () => {
    expect(parseReloadCooldownRecord(JSON.stringify({ version: "v2" }))).toBeNull();
    expect(
      parseReloadCooldownRecord(JSON.stringify({ version: "v2", reloadedAt: "not-a-number" })),
    ).toBeNull();
  });
});

describe("serializePollState / parsePollState (round-trip)", () => {
  it("シリアライズしたものをそのままパースすると同じ内容が復元される", () => {
    const state = {
      pollCursor: "2026-07-04T00:00:00.000Z",
      pollHistoryId: historyUuid(3),
      seenHistoryIds: ["h1", "h2", "h3"],
      savedAt: 1_700_000_000_000,
    };
    const serialized = serializePollState(state);
    const parsed = parsePollState(serialized, state.savedAt, POLLSTATE_TTL_MS);
    expect(parsed).toEqual(state);
  });

  it("seenHistoryIdsがMAX_PERSISTED_HISTORY_IDSを超える場合は直近(末尾)側だけが残る", () => {
    const ids = Array.from({ length: MAX_PERSISTED_HISTORY_IDS + 10 }, (_, i) => `h${i}`);
    const serialized = serializePollState({
      pollCursor: "2026-07-04T00:00:00.000Z",
      pollHistoryId: historyUuid(4),
      seenHistoryIds: ids,
      savedAt: 0,
    });
    const parsed = parsePollState(serialized, 0, POLLSTATE_TTL_MS);
    expect(parsed?.seenHistoryIds).toHaveLength(MAX_PERSISTED_HISTORY_IDS);
    // 末尾側(最新側)が残ることを確認
    expect(parsed?.seenHistoryIds[0]).toBe(`h${10}`);
    expect(parsed?.seenHistoryIds.at(-1)).toBe(`h${ids.length - 1}`);
  });

  it("savedAtからちょうどttlMs経過した境界ではまだ有効(復元される)", () => {
    const state = {
      pollCursor: "2026-07-04T00:00:00.000Z",
      pollHistoryId: historyUuid(5),
      seenHistoryIds: [],
      savedAt: 1000,
    };
    const serialized = serializePollState(state);
    const now = 1000 + POLLSTATE_TTL_MS;
    expect(parsePollState(serialized, now, POLLSTATE_TTL_MS)).toEqual(state);
  });

  it("savedAtからttlMsを1msでも超えるとTTL切れでnullを返す", () => {
    const state = {
      pollCursor: "2026-07-04T00:00:00.000Z",
      pollHistoryId: historyUuid(6),
      seenHistoryIds: [],
      savedAt: 1000,
    };
    const serialized = serializePollState(state);
    const now = 1000 + POLLSTATE_TTL_MS + 1;
    expect(parsePollState(serialized, now, POLLSTATE_TTL_MS)).toBeNull();
  });
});

describe("parsePollState: 壊れた入力への耐性", () => {
  it("rawがnullならnullを返す", () => {
    expect(parsePollState(null, Date.now(), POLLSTATE_TTL_MS)).toBeNull();
  });

  it("rawがundefinedならnullを返す", () => {
    expect(parsePollState(undefined, Date.now(), POLLSTATE_TTL_MS)).toBeNull();
  });

  it("rawが空文字列ならnullを返す", () => {
    expect(parsePollState("", Date.now(), POLLSTATE_TTL_MS)).toBeNull();
  });

  it("JSONとしてparseできない壊れた文字列でも例外を投げずnullを返す", () => {
    expect(() => parsePollState("{not valid json", Date.now(), POLLSTATE_TTL_MS)).not.toThrow();
    expect(parsePollState("{not valid json", Date.now(), POLLSTATE_TTL_MS)).toBeNull();
  });

  it("JSONとして正当だがオブジェクトでない場合(数値)はnullを返す", () => {
    expect(parsePollState("42", Date.now(), POLLSTATE_TTL_MS)).toBeNull();
  });

  it("JSONとして正当だがオブジェクトでない場合(文字列)はnullを返す", () => {
    expect(parsePollState('"hello"', Date.now(), POLLSTATE_TTL_MS)).toBeNull();
  });

  it("JSONとして正当だがnullの場合はnullを返す", () => {
    expect(parsePollState("null", Date.now(), POLLSTATE_TTL_MS)).toBeNull();
  });

  it("pollCursorが欠けている場合はnullを返す", () => {
    const raw = JSON.stringify({ seenHistoryIds: [], savedAt: 0 });
    expect(parsePollState(raw, 0, POLLSTATE_TTL_MS)).toBeNull();
  });

  it("savedAtが欠けている/数値でない場合はnullを返す", () => {
    const raw = JSON.stringify({
      pollCursor: "2026-07-04T00:00:00.000Z",
      seenHistoryIds: [],
      savedAt: "not-a-number",
    });
    expect(parsePollState(raw, 0, POLLSTATE_TTL_MS)).toBeNull();
  });

  it("seenHistoryIdsが配列でない場合はnullを返す", () => {
    const raw = JSON.stringify({
      pollCursor: "2026-07-04T00:00:00.000Z",
      seenHistoryIds: "not-an-array",
      savedAt: 0,
    });
    expect(parsePollState(raw, 0, POLLSTATE_TTL_MS)).toBeNull();
  });

  // pollCursor は復元後そのまま ?since= としてサーバへ送られ、日付として解釈
  // できない値は API 側で 400 拒否される。壊れた/汚染された sessionStorage から
  // の復元で全ポーリングが 400 になるのを防ぐため、parsePollState 自体が弾く。
  it("pollCursorが日付として解釈できない文字列の場合はnullを返す(以後のポーリングが全て400になるのを防ぐ)", () => {
    const raw = JSON.stringify({
      pollCursor: "not-a-date",
      seenHistoryIds: ["h1"],
      savedAt: 0,
    });
    expect(parsePollState(raw, 0, POLLSTATE_TTL_MS)).toBeNull();
  });

  it("pollCursorが空文字列の場合はnullを返す", () => {
    const raw = JSON.stringify({ pollCursor: "", seenHistoryIds: [], savedAt: 0 });
    expect(parsePollState(raw, 0, POLLSTATE_TTL_MS)).toBeNull();
  });

  it("Date.parse可能でもAPI文法外のpollCursorは400ループを避けるため拒否する", () => {
    const raw = JSON.stringify({
      pollCursor: "July 24, 2026",
      pollHistoryId: historyUuid(8),
      seenHistoryIds: [],
      savedAt: 0,
    });
    expect(parsePollState(raw, 0, POLLSTATE_TTL_MS)).toBeNull();
  });

  it("PostgreSQLのoffset/microsecond cursorをAPIと同じcanonical UTCで復元する", () => {
    const raw = JSON.stringify({
      pollCursor: "2026-07-24T09:00:01.123456+09:00",
      pollHistoryId: historyUuid(9),
      seenHistoryIds: [],
      savedAt: 0,
    });
    expect(parsePollState(raw, 0, POLLSTATE_TTL_MS)?.pollCursor).toBe(
      "2026-07-24T00:00:01.123456Z",
    );
  });

  it("pollCursorが正当なISO日付文字列なら復元される(妥当性検証のデグレ防止)", () => {
    const raw = JSON.stringify({
      pollCursor: "2026-07-04T12:34:56.789Z",
      seenHistoryIds: ["h1"],
      savedAt: 0,
    });
    expect(parsePollState(raw, 0, POLLSTATE_TTL_MS)).toEqual({
      pollCursor: "2026-07-04T12:34:56.789Z",
      pollHistoryId: "",
      seenHistoryIds: ["h1"],
      savedAt: 0,
    });
  });

  it("pollHistoryIdがあるsnapshotは同一timestampのtie-breakerを保持する", () => {
    const raw = JSON.stringify({
      pollCursor: "2026-07-04T12:34:56.789Z",
      pollHistoryId: historyUuid(7),
      seenHistoryIds: [],
      savedAt: 0,
    });
    expect(parsePollState(raw, 0, POLLSTATE_TTL_MS)).toMatchObject({
      pollCursor: "2026-07-04T12:34:56.789Z",
      pollHistoryId: historyUuid(7),
    });
  });

  it("oversized pollHistoryIdは汚染snapshotとして拒否する", () => {
    const raw = JSON.stringify({
      pollCursor: "2026-07-04T12:34:56.789Z",
      pollHistoryId: "h".repeat(129),
      seenHistoryIds: [],
      savedAt: 0,
    });
    expect(parsePollState(raw, 0, POLLSTATE_TTL_MS)).toBeNull();
  });

  it("APIが受理しない非UUID pollHistoryIdは400ループを避けるため拒否する", () => {
    const raw = JSON.stringify({
      pollCursor: "2026-07-04T12:34:56.789Z",
      pollHistoryId: "history-not-a-uuid",
      seenHistoryIds: [],
      savedAt: 0,
    });
    expect(parsePollState(raw, 0, POLLSTATE_TTL_MS)).toBeNull();
  });

  it("seenHistoryIds配列内に文字列以外が混じっていても、文字列要素だけを残して復元する", () => {
    const raw = JSON.stringify({
      pollCursor: "2026-07-04T00:00:00.000Z",
      seenHistoryIds: ["h1", 123, null, "h2", { bad: true }],
      savedAt: 0,
    });
    const parsed = parsePollState(raw, 0, POLLSTATE_TTL_MS);
    expect(parsed?.seenHistoryIds).toEqual(["h1", "h2"]);
  });
});
