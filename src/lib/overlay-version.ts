/**
 * Issue #569: overlay ページ(src/app/overlay/[streamerId]/page.tsx)の
 * 「バージョン不一致検出＋アイドル時自動リロード」に関する純粋関数群。
 *
 * sessionStorage や `Date.now()`・`setTimeout`・`location.reload()` などの
 * 副作用を持つAPIには一切アクセスせず、必要な値(現在時刻・クールダウン記録・
 * TTLなど)は全て引数として受け取る設計にしている。これにより overlay ページ
 * 本体(ブラウザ環境・Reactのライフサイクル)を経由せずに、あらゆる分岐を
 * ユニットテストできる。
 *
 * 呼び出し側(page.tsx)の責務:
 * - sessionStorage の実際の読み書き(OBS等で無効な環境向けにtry/catchで包む)
 * - setTimeout によるジッター/演出中の再試行のスケジューリング
 * - location.reload() の実行
 */

import { isValidOverlayHistoryId } from "@/lib/overlay-realtime/contract";
import { normalizeOverlayHistoryTimestamp } from "@/lib/overlay-history-cursor";

/** sessionStorage に保存するクールダウン記録(直前にリロードしたバージョンと時刻)の型 */
export interface ReloadCooldownRecord {
  version: string;
  reloadedAt: number;
}

/** sessionStorage に退避するポーリング状態のスナップショット */
export interface OverlayPollStateSnapshot {
  pollCursor: string;
  /** Tie-breaker for rows that share the exact same redeemed_at value. */
  pollHistoryId: string;
  seenHistoryIds: string[];
  savedAt: number;
}

/**
 * 同一バージョンへのリロードを許可する最短間隔(ミリ秒)。
 *
 * 「一度リロードしたら二度と自動リロードしない」という恒久的な一回限りガードに
 * しない理由: 本番を旧バージョンへロールバックした場合、クライアントは
 * 「(ロールバック後の)新しいバージョンへ戻る」ためにもう一度リロードする必要が
 * あるが、恒久ガードだとロールバック後に復帰できなくなってしまう。
 * クールダウン方式にすることで「同一バージョンへの往復リロード連発」だけを防ぎ
 * つつ、一定時間が経てば何度でも追従できるようにする。
 */
export const RELOAD_COOLDOWN_MS = 60 * 60 * 1000; // 60分

/**
 * クールダウン記録として保持する直近バージョンの最大件数(Issue #634)。
 *
 * 旧設計は「直前に1回リロードした先のバージョン」だけを記録していたため、
 * Cloudflare Workersのローリングデプロイ中に新旧バージョンが混在する
 * ウィンドウで、overlayクライアントが受信するoverlayVersionが A→B→A→B の
 * ように往復すると、各方向がその都度「記録に無い別バージョンへの初回リロード」
 * として扱われ、クールダウンが実質機能せず短時間に複数回 location.reload()
 * され得た。
 *
 * 直近見た複数バージョンをセットとして保持することで、A/B間の往復が一巡した
 * 後は双方向ともクールダウン対象になり、それ以降の余分なリロードを防げる
 * (1巡目のA→Bおよびその直後のB→Aは、そのバージョンへの初回リロードとして
 * 想定通り許可される。往復を検知してから抑止する設計であり、1回も
 * リロードせずに往復を予知することはできない)。
 *
 * ローリングデプロイで同時に混在するバージョンは通常2つ(旧/新)だが、
 * 短時間に連続するデプロイも考慮し、多少の余裕を持たせて4件まで保持する
 * (無制限保持によるsessionStorage肥大化・直近判定の希薄化を避ける)。
 */
export const MAX_RELOAD_COOLDOWN_RECORDS = 4;

/**
 * sessionStorage に退避したポーリング状態(pollCursor/seenHistoryIds)を
 * 有効とみなす最長時間(ミリ秒)。これを超えて放置された古い状態は捨てて、
 * 通常どおり「今」を起点にポーリングを再開する(古いカーソルを使い続けて
 * 取りこぼし・重複判定の不整合を起こさないため)。
 */
export const POLLSTATE_TTL_MS = 15 * 60 * 1000; // 15分

/**
 * sessionStorage に退避する seenHistoryIds の最大件数。無制限に保存すると
 * sessionStorage の容量やシリアライズ・復元コストが不必要に増えるため、
 * 直近分(Set の挿入順で最新側)だけを残す。リロード窓をまたぐ重複表示防止が
 * 目的であり、全履歴を保持する必要はない。
 */
export const MAX_PERSISTED_HISTORY_IDS = 50;

/**
 * 自身のビルドバージョン(current)とポーリング応答から受け取ったバージョン
 * (received)を比較し、リロードをスケジュールすべきかを判定する。
 *
 * - current/received のいずれかが空文字列・undefined なら判定不能として false
 * - どちらかが 'dev' なら false — ローカル開発環境やgit不在でのビルドは
 *   常に 'dev' になり得る。'dev' を通常のバージョン文字列と同列に比較すると、
 *   'dev' な自分 と 本番の実SHA が常に「不一致」判定されてリロードループの
 *   原因になりかねないため、'dev' が絡む比較は意図的にスキップする。
 * - 上記以外で文字列が異なれば true
 */
export function shouldScheduleReload(current: string, received: string | undefined): boolean {
  if (!current || !received) return false;
  if (current === "dev" || received === "dev") return false;
  return current !== received;
}

/**
 * targetVersion へのリロードが現在クールダウン中(＝直近 cooldownMs 以内に
 * 同じバージョンへ既にリロード済み)かどうかを判定する。
 *
 * records は直近リロードした(複数の)バージョンの記録の配列(Issue #634)。
 * targetVersion と一致するエントリが records 内のいずれかに存在し、かつ
 * その reloadedAt から cooldownMs 未満しか経過していなければクールダウン中と
 * みなす。records が null・空配列、または targetVersion と一致するエントリが
 * 一件も無い場合は常に false を返す(そのバージョンへの初回リロードとして
 * 独立にカウントする)。
 */
export function isReloadCooldownActive(
  records: ReloadCooldownRecord[] | null,
  targetVersion: string,
  now: number,
  cooldownMs: number,
): boolean {
  if (!records) return false;
  return records.some(
    (record) => record.version === targetVersion && now - record.reloadedAt < cooldownMs,
  );
}

/**
 * targetVersion へのリロード実行をクールダウン記録へ追記する純粋関数(Issue #634)。
 *
 * 同一バージョンの既存エントリがあれば取り除いてから追記する(重複を持たず、
 * 常に最新の reloadedAt だけを保持する＝そのバージョンへ再訪した時点で
 * クールダウンの起点も更新される)。MAX_RELOAD_COOLDOWN_RECORDS を超える場合は
 * 最も古い(挿入順で先頭側の)エントリから破棄する(往復検出には直近見た
 * バージョンほど有用なため)。
 */
export function appendReloadCooldownRecord(
  records: ReloadCooldownRecord[] | null,
  version: string,
  reloadedAt: number,
): ReloadCooldownRecord[] {
  const withoutSameVersion = (records ?? []).filter((record) => record.version !== version);
  const appended = [...withoutSameVersion, { version, reloadedAt }];
  return appended.slice(-MAX_RELOAD_COOLDOWN_RECORDS);
}

/**
 * sessionStorage に保存されたクールダウン記録(JSON文字列)をパースする。
 *
 * Issue #634 より前のクライアントは単一の { version, reloadedAt } オブジェクト
 * を書き込んでいた。ローリングデプロイで新旧コードが混在する間、既に開いている
 * OBS タブが旧形式の値を書き込んだ直後に新コードへ切り替わるウィンドウが
 * あり得るため、旧形式(単一オブジェクト)も 1 件配列として読み込めるようにし、
 * デプロイ境界をまたいでクールダウン記録が失われないようにする。
 *
 * parsePollState と同様、以下のいずれかに該当する場合は例外を投げず null を
 * 返す(呼び出し側は「クールダウン記録なし」として扱い、安全側に倒れる):
 * - raw が null/undefined/空文字列
 * - JSON として parse できない(壊れたデータ)
 * - 配列でも { version, reloadedAt } 形状のオブジェクト(旧形式)でもない
 * - 配列内の個々のエントリが期待する形状(version: string, reloadedAt: number)
 *   を満たさない場合はそのエントリだけを無視する(parsePollState の
 *   seenHistoryIds フィルタと同じ「壊れた要素だけ捨てる」方針)。結果として
 *   有効なエントリが 1 件も残らなければ null を返す。
 */
export function parseReloadCooldownRecords(
  raw: string | null | undefined,
): ReloadCooldownRecord[] | null {
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object") return null;

  // 旧形式(Issue #634 より前): 単一オブジェクトを 1 件配列として扱う。
  const rawEntries: unknown[] = Array.isArray(parsed) ? parsed : [parsed];

  const validEntries: ReloadCooldownRecord[] = [];
  for (const entry of rawEntries) {
    if (!entry || typeof entry !== "object") continue;
    const candidate = entry as Record<string, unknown>;
    if (typeof candidate.version !== "string") continue;
    if (typeof candidate.reloadedAt !== "number") continue;
    validEntries.push({ version: candidate.version, reloadedAt: candidate.reloadedAt });
  }

  if (validEntries.length === 0) return null;

  // 自前の書き込み(appendReloadCooldownRecord)は常に上限内に収まるが、
  // 外部からの汚染や将来の互換性崩れに備え読み取り側でも直近側だけへ切り詰める。
  return validEntries.slice(-MAX_RELOAD_COOLDOWN_RECORDS);
}

/**
 * ポーリング状態(pollCursor/seenHistoryIds)をリロード直前に sessionStorage へ
 * 退避するため JSON 文字列にシリアライズする。
 * seenHistoryIds は直近 MAX_PERSISTED_HISTORY_IDS 件(配列末尾側 = Set の
 * 挿入順で最新側)だけを残す。
 */
export function serializePollState(state: {
  pollCursor: string;
  pollHistoryId?: string;
  seenHistoryIds: string[];
  savedAt: number;
}): string {
  const snapshot: OverlayPollStateSnapshot = {
    pollCursor: state.pollCursor,
    // Optional input keeps snapshots produced by the previous page contract
    // readable while every new writer persists the exact DB tie-breaker.
    pollHistoryId: state.pollHistoryId ?? "",
    seenHistoryIds: state.seenHistoryIds.slice(-MAX_PERSISTED_HISTORY_IDS),
    savedAt: state.savedAt,
  };
  return JSON.stringify(snapshot);
}

/**
 * serializePollState の逆変換。以下のいずれかに該当する場合は null を返し、
 * 呼び出し側は「復元しない(＝今を起点にポーリングを再開する)」ものとして
 * 扱う:
 * - raw が null/undefined/空文字列
 * - JSON として parse できない(壊れたデータ)
 * - 期待する形状(pollCursor: string, optional pollHistoryId: string,
 *   seenHistoryIds: string[], savedAt: number)を満たさない
 * - pollCursor が日付として解釈できない(Date.parse が NaN)
 * - savedAt から now までの経過が ttlMs を超えている(TTL切れ)
 *
 * OBS ブラウザソース等 sessionStorage の内容が外部から書き換えられ得る前提を
 * 置き、壊れた入力でも例外を投げず null を返すことを保証する
 * (このモジュールを呼ぶ page.tsx 側の try/catch とは独立した防御)。
 */
export function parsePollState(
  raw: string | null | undefined,
  now: number,
  ttlMs: number,
): OverlayPollStateSnapshot | null {
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object") return null;
  const candidate = parsed as Record<string, unknown>;

  const normalizedPollCursor = normalizeOverlayHistoryTimestamp(candidate.pollCursor);
  if (!normalizedPollCursor) return null;
  if (
    candidate.pollHistoryId !== undefined
    && (
      typeof candidate.pollHistoryId !== "string"
      || (
        candidate.pollHistoryId !== ""
        && !isValidOverlayHistoryId(candidate.pollHistoryId)
      )
    )
  ) return null;
  if (typeof candidate.savedAt !== "number") return null;
  if (!Array.isArray(candidate.seenHistoryIds)) return null;

  if (now - candidate.savedAt > ttlMs) return null;

  // 配列内に文字列以外が混じっていても(壊れたデータ)無視して安全側に倒す
  const seenHistoryIds = candidate.seenHistoryIds.filter(
    (id): id is string => typeof id === "string",
  );

  return {
    pollCursor: normalizedPollCursor,
    // Old builds wrote timestamp-only snapshots. Preserve compatibility with
    // an empty tie-breaker; page.tsx rewinds that legacy timestamp slightly so
    // equal-time rows are re-read and deduped instead of skipped.
    pollHistoryId:
      typeof candidate.pollHistoryId === "string"
        ? candidate.pollHistoryId
        : "",
    seenHistoryIds,
    savedAt: candidate.savedAt,
  };
}
