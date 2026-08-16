import { describe, it, expect } from "vitest";
import {
  shouldScheduleReload,
  isReloadCooldownActive,
  upsertReloadCooldownRecord,
  serializePollState,
  parsePollState,
  parseReloadCooldownRecords,
  RELOAD_COOLDOWN_MS,
  POLLSTATE_TTL_MS,
  MAX_PERSISTED_HISTORY_IDS,
  MAX_RELOAD_COOLDOWN_RECORDS,
  type ReloadCooldownRecord,
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
  it("recordsがnull(未リロード)ならfalseを返す", () => {
    expect(isReloadCooldownActive(null, "v2", 100000, RELOAD_COOLDOWN_MS)).toBe(false);
  });

  it("recordsが空配列ならfalseを返す", () => {
    expect(isReloadCooldownActive([], "v2", 100000, RELOAD_COOLDOWN_MS)).toBe(false);
  });

  it("記録内のバージョンがどれもtargetVersionと異なればfalseを返す(別バージョンは独立してカウント)", () => {
    const records = [{ version: "v1", reloadedAt: 100000 }];
    expect(isReloadCooldownActive(records, "v2", 100000 + 1000, RELOAD_COOLDOWN_MS)).toBe(false);
  });

  it("同一バージョンでcooldownMs未満ならtrueを返す(クールダウン中)", () => {
    const records = [{ version: "v2", reloadedAt: 100000 }];
    const now = 100000 + RELOAD_COOLDOWN_MS - 1;
    expect(isReloadCooldownActive(records, "v2", now, RELOAD_COOLDOWN_MS)).toBe(true);
  });

  it("同一バージョンでちょうどcooldownMs経過した境界ではfalseを返す(クールダウン明け)", () => {
    const records = [{ version: "v2", reloadedAt: 100000 }];
    const now = 100000 + RELOAD_COOLDOWN_MS;
    expect(isReloadCooldownActive(records, "v2", now, RELOAD_COOLDOWN_MS)).toBe(false);
  });

  it("同一バージョンでcooldownMsを超えて経過していればfalseを返す", () => {
    const records = [{ version: "v2", reloadedAt: 100000 }];
    const now = 100000 + RELOAD_COOLDOWN_MS + 1;
    expect(isReloadCooldownActive(records, "v2", now, RELOAD_COOLDOWN_MS)).toBe(false);
  });

  it("ロールバック相当のシナリオ: これまで一度も記録されていない全く別のバージョンへは即座にリロード可能", () => {
    // v1(現行) -> v2(新版)へリロード済みの直後に、本番がv3(v1/v2いずれとも異なる版)へ
    // ロールバックされたケース。v3向けのクールダウン記録はまだ無いため、
    // v3への再リロードはクールダウンの影響を受けない。
    const records = [{ version: "v2", reloadedAt: 100000 }];
    const now = 100000 + 1000; // v2へのクールダウン期間内
    expect(isReloadCooldownActive(records, "v3", now, RELOAD_COOLDOWN_MS)).toBe(false);
  });

  it("記録が複数件ある場合、いずれかのエントリがクールダウン中ならtrueを返す(Issue #634)", () => {
    // ローリングデプロイ中にv1→v2→v1と往復した後の状態を模した複数エントリ。
    const records: ReloadCooldownRecord[] = [
      { version: "v2", reloadedAt: 100000 },
      { version: "v1", reloadedAt: 101000 },
    ];
    // v2は直前ではなく1つ前のエントリだが、cooldownMs以内であれば引き続き検出される
    expect(isReloadCooldownActive(records, "v2", 101500, RELOAD_COOLDOWN_MS)).toBe(true);
    expect(isReloadCooldownActive(records, "v1", 101500, RELOAD_COOLDOWN_MS)).toBe(true);
  });
});

describe("upsertReloadCooldownRecord (Issue #634)", () => {
  it("recordsがnullの場合は新規エントリ1件の配列を返す", () => {
    expect(upsertReloadCooldownRecord(null, "v1", 100)).toEqual([
      { version: "v1", reloadedAt: 100 },
    ]);
  });

  it("既存の空配列に追記できる", () => {
    expect(upsertReloadCooldownRecord([], "v1", 100)).toEqual([
      { version: "v1", reloadedAt: 100 },
    ]);
  });

  it("同一バージョンの既存エントリは古いものを置き換える(重複を持たない)", () => {
    const records: ReloadCooldownRecord[] = [{ version: "v1", reloadedAt: 100 }];
    expect(upsertReloadCooldownRecord(records, "v1", 200)).toEqual([
      { version: "v1", reloadedAt: 200 },
    ]);
  });

  it("異なるバージョンは既存エントリを保持したまま追記される", () => {
    const records: ReloadCooldownRecord[] = [{ version: "v1", reloadedAt: 100 }];
    expect(upsertReloadCooldownRecord(records, "v2", 200)).toEqual([
      { version: "v1", reloadedAt: 100 },
      { version: "v2", reloadedAt: 200 },
    ]);
  });

  it(`MAX_RELOAD_COOLDOWN_RECORDS(${MAX_RELOAD_COOLDOWN_RECORDS}件)を超える場合は最も古いエントリから破棄する`, () => {
    let records: ReloadCooldownRecord[] | null = null;
    for (let i = 0; i < MAX_RELOAD_COOLDOWN_RECORDS + 2; i++) {
      records = upsertReloadCooldownRecord(records, `v${i}`, i);
    }
    expect(records).toHaveLength(MAX_RELOAD_COOLDOWN_RECORDS);
    // 直近MAX_RELOAD_COOLDOWN_RECORDS件だけが残る(先頭の古いものが破棄される)
    const expectedVersions = Array.from(
      { length: MAX_RELOAD_COOLDOWN_RECORDS },
      (_, i) => `v${i + 2}`,
    );
    expect(records?.map((r) => r.version)).toEqual(expectedVersions);
  });
});

describe("ローリングデプロイ中のバージョン往復への耐性(Issue #634)", () => {
  it("A→B→A→Bと往復しても、双方向とも一度記録された後の再訪問はクールダウンで抑止される", () => {
    const cooldownMs = RELOAD_COOLDOWN_MS;
    let records: ReloadCooldownRecord[] | null = null;
    let now = 0;

    // 初回: current=A, received=B(未記録) → リロード許可、実行して記録
    expect(isReloadCooldownActive(records, "v-b", now, cooldownMs)).toBe(false);
    records = upsertReloadCooldownRecord(records, "v-b", now);

    // ローリングデプロイの混在ウィンドウで別エッジからv-aが返る(未記録)→リロード許可、実行して記録
    now += 1000;
    expect(isReloadCooldownActive(records, "v-a", now, cooldownMs)).toBe(false);
    records = upsertReloadCooldownRecord(records, "v-a", now);

    // 再度v-bが返る → 直前のv-b記録がクールダウン中のため、往復2巡目以降は抑止される
    now += 1000;
    expect(isReloadCooldownActive(records, "v-b", now, cooldownMs)).toBe(true);

    // 再度v-aが返る → 同様に抑止される
    now += 1000;
    expect(isReloadCooldownActive(records, "v-a", now, cooldownMs)).toBe(true);

    // 何度往復してもクールダウン中は追加リロードが発生しないことを確認
    for (let i = 0; i < 5; i++) {
      now += 1000;
      expect(isReloadCooldownActive(records, i % 2 === 0 ? "v-a" : "v-b", now, cooldownMs)).toBe(
        true,
      );
    }
  });

  it("往復ではない一度きりのロールバックでは、既存挙動どおり新バージョンへ即座に切り替わる", () => {
    // v-bへ一度だけリロードした後、これまで一度も見ていないv-cへロールバックされた場合、
    // v-cは記録に無いため即座にリロード許可される(#634受け入れ条件3番目: 既存挙動を壊さない)。
    const records = upsertReloadCooldownRecord(null, "v-b", 0);
    expect(isReloadCooldownActive(records, "v-c", 1000, RELOAD_COOLDOWN_MS)).toBe(false);
  });

  it("クールダウン明け後は往復した同一バージョンへも再度リロードできる(恒久ガードにしない)", () => {
    const records = upsertReloadCooldownRecord(null, "v-b", 0);
    const now = RELOAD_COOLDOWN_MS; // ちょうどクールダウン明けの境界
    expect(isReloadCooldownActive(records, "v-b", now, RELOAD_COOLDOWN_MS)).toBe(false);
  });
});

describe("parseReloadCooldownRecords", () => {
  it("新形式(配列)のJSONをReloadCooldownRecord[]として復元する", () => {
    const raw = JSON.stringify([
      { version: "v1", reloadedAt: 100 },
      { version: "v2", reloadedAt: 12345 },
    ]);
    expect(parseReloadCooldownRecords(raw)).toEqual([
      { version: "v1", reloadedAt: 100 },
      { version: "v2", reloadedAt: 12345 },
    ]);
  });

  it("rawがnull/undefined/空文字列ならnullを返す", () => {
    expect(parseReloadCooldownRecords(null)).toBeNull();
    expect(parseReloadCooldownRecords(undefined)).toBeNull();
    expect(parseReloadCooldownRecords("")).toBeNull();
  });

  it("JSONとしてparseできない壊れた文字列でも例外を投げずnullを返す", () => {
    expect(() => parseReloadCooldownRecords("{broken")).not.toThrow();
    expect(parseReloadCooldownRecords("{broken")).toBeNull();
  });

  it("トップレベルが配列でない場合はnullを返す(数値・null・文字列)", () => {
    expect(parseReloadCooldownRecords("42")).toBeNull();
    expect(parseReloadCooldownRecords("null")).toBeNull();
    expect(parseReloadCooldownRecords('"v2"')).toBeNull();
  });

  // Issue #634でストレージキーをv2へ分離したため、新キーの下に単一オブジェクト
  // (旧形式)が書かれる正常経路は無い。それでも汚染データへの防御として
  // 配列以外は一律nullで拒否する(overlay-version.tsのparseReloadCooldownRecords
  // doc参照)。
  it("トップレベルが単一オブジェクト(旧形式相当)ならnullを返す", () => {
    expect(parseReloadCooldownRecords(JSON.stringify({ version: "v2", reloadedAt: 12345 }))).toBeNull();
  });

  it("空配列はnullを返す(有効なエントリなし)", () => {
    expect(parseReloadCooldownRecords("[]")).toBeNull();
  });

  it("配列内の不正な要素だけを無視し、有効な要素は復元する(parsePollStateのフィルタ方針と同じ)", () => {
    const raw = JSON.stringify([
      { version: "v1", reloadedAt: 1 },
      "garbage",
      { version: "v2" }, // reloadedAt欠落
      { version: "v2b", reloadedAt: "not-a-number" }, // reloadedAtが数値でない
      { version: 123, reloadedAt: 2 }, // versionが文字列でない
      { version: "v3", reloadedAt: 3 },
    ]);
    expect(parseReloadCooldownRecords(raw)).toEqual([
      { version: "v1", reloadedAt: 1 },
      { version: "v3", reloadedAt: 3 },
    ]);
  });

  it("全要素が不正な配列はnullを返す", () => {
    const raw = JSON.stringify(["garbage", { version: 1 }, null]);
    expect(parseReloadCooldownRecords(raw)).toBeNull();
  });

  it(`MAX_RELOAD_COOLDOWN_RECORDS(${MAX_RELOAD_COOLDOWN_RECORDS}件)を超える配列は直近側だけへ切り詰める(読み取り側の防御)`, () => {
    const entries = Array.from({ length: MAX_RELOAD_COOLDOWN_RECORDS + 3 }, (_, i) => ({
      version: `v${i}`,
      reloadedAt: i,
    }));
    const parsed = parseReloadCooldownRecords(JSON.stringify(entries));
    expect(parsed).toHaveLength(MAX_RELOAD_COOLDOWN_RECORDS);
    expect(parsed?.[0].version).toBe("v3");
    expect(parsed?.at(-1)?.version).toBe(`v${entries.length - 1}`);
  });

  // page.tsxの実際の書き込み経路(JSON.stringify(upsertReloadCooldownRecord(...)))を
  // そのまま再現するround-tripテスト。PR #994レビュー指摘: 純粋関数単体のテストだけ
  // では「既存記録を引数に渡し忘れて実質nullのまま追記してしまう」ような呼び出し
  // 側の結線バグ(Issue #634の本質的な修正対象)を検知できない。upsert→serialize→
  // parseを連鎖させることで、page.tsx側の呼び出しパターンに近い形で検証する
  // (コンポーネントレベルの検証は tests/unit/components/overlay-page.test.tsx 側で
  // 実際のsessionStorage書き込み結果を直接アサートする形でも行う)。
  it("upsertした結果をシリアライズしてパースすると、複数バージョンの履歴を保持したまま復元される", () => {
    let records: ReloadCooldownRecord[] | null = null;
    records = upsertReloadCooldownRecord(records, "v-b", 1000);
    records = parseReloadCooldownRecords(JSON.stringify(records));
    records = upsertReloadCooldownRecord(records, "v-a", 2000);
    records = parseReloadCooldownRecords(JSON.stringify(records));

    expect(records).toEqual([
      { version: "v-b", reloadedAt: 1000 },
      { version: "v-a", reloadedAt: 2000 },
    ]);
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
