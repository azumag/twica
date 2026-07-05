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

/** sessionStorage に保存するクールダウン記録(直前にリロードしたバージョンと時刻)の型 */
export interface ReloadCooldownRecord {
  version: string;
  reloadedAt: number;
}

/** sessionStorage に退避するポーリング状態のスナップショット */
export interface OverlayPollStateSnapshot {
  pollCursor: string;
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
 * record が null(まだ一度もリロード記録が無い)、または記録されている
 * バージョンが targetVersion と異なる(＝別バージョンへのリロードなので
 * 独立してカウントする)場合は常に false を返す。
 */
export function isReloadCooldownActive(
  record: ReloadCooldownRecord | null,
  targetVersion: string,
  now: number,
  cooldownMs: number,
): boolean {
  if (!record) return false;
  if (record.version !== targetVersion) return false;
  return now - record.reloadedAt < cooldownMs;
}

/**
 * sessionStorage に保存されたクールダウン記録(JSON文字列)をパースする。
 * parsePollState と同様、以下のいずれかに該当する場合は例外を投げず null を
 * 返す(呼び出し側は「クールダウン記録なし」として扱い、安全側に倒れる):
 * - raw が null/undefined/空文字列
 * - JSON として parse できない(壊れたデータ)
 * - 期待する形状(version: string, reloadedAt: number)を満たさない
 */
export function parseReloadCooldownRecord(
  raw: string | null | undefined,
): ReloadCooldownRecord | null {
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object") return null;
  const candidate = parsed as Record<string, unknown>;

  if (typeof candidate.version !== "string") return null;
  if (typeof candidate.reloadedAt !== "number") return null;

  return { version: candidate.version, reloadedAt: candidate.reloadedAt };
}

/**
 * ポーリング状態(pollCursor/seenHistoryIds)をリロード直前に sessionStorage へ
 * 退避するため JSON 文字列にシリアライズする。
 * seenHistoryIds は直近 MAX_PERSISTED_HISTORY_IDS 件(配列末尾側 = Set の
 * 挿入順で最新側)だけを残す。
 */
export function serializePollState(state: {
  pollCursor: string;
  seenHistoryIds: string[];
  savedAt: number;
}): string {
  const snapshot: OverlayPollStateSnapshot = {
    pollCursor: state.pollCursor,
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
 * - 期待する形状(pollCursor: string, seenHistoryIds: string[], savedAt: number)
 *   を満たさない
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

  if (typeof candidate.pollCursor !== "string") return null;
  if (typeof candidate.savedAt !== "number") return null;
  if (!Array.isArray(candidate.seenHistoryIds)) return null;

  if (now - candidate.savedAt > ttlMs) return null;

  // 配列内に文字列以外が混じっていても(壊れたデータ)無視して安全側に倒す
  const seenHistoryIds = candidate.seenHistoryIds.filter(
    (id): id is string => typeof id === "string",
  );

  return { pollCursor: candidate.pollCursor, seenHistoryIds, savedAt: candidate.savedAt };
}
