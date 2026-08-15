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

/**
 * クールダウン記録1件分の型(あるバージョンへ最後にリロードした時刻)。
 * Issue #634 より、sessionStorage には単体ではなくこの型の配列
 * (ReloadCooldownRecord[])を保持する。直近見た複数バージョンを保持する
 * 理由は MAX_RELOAD_COOLDOWN_RECORDS の doc を参照。
 */
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
 *
 * トレードオフ(自動レビューで指摘): 保持対象が「直前の1件」から「直近N件」へ
 * 広がったことで、60分以内に一度リロード先となったバージョンへ戻る正規の
 * 再デプロイ(ロールバック後のfix-forwardで同一アーティファクトを再配信する等)
 * も、往復と区別できずクールダウン対象になる。旧設計では直前の1件と一致
 * しない限り即座に追従できていたため、この点は挙動変更である。往復リロード
 * 連発(配信画面の破壊)を防ぐ利益の方が明確に大きいため許容するが、運用者は
 * 「同一バージョンへの再デプロイは直近リロードから最大60分反映が遅れ得る」
 * ことを認識しておく必要がある(RELOAD_COOLDOWN_MSのdocにある「恒久ガードに
 * しない」方針により、60分を超えれば自然に追従する)。
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
 * targetVersion へのリロード実行をクールダウン記録へ反映する純粋関数(Issue #634)。
 * 同一バージョンの既存エントリを更新するか、無ければ新規追加するupsertであり、
 * 単純な追記ではない(この関数名はその意図を明示する)。
 *
 * 同一バージョンの既存エントリがあれば取り除いてから追記する(重複を持たず、
 * 常に最新の reloadedAt だけを保持する＝そのバージョンへ再訪した時点で
 * クールダウンの起点も更新される)。MAX_RELOAD_COOLDOWN_RECORDS を超える場合は
 * 最も古い(挿入順で先頭側の)エントリから破棄する(往復検出には直近見た
 * バージョンほど有用なため)。
 */
export function upsertReloadCooldownRecord(
  records: ReloadCooldownRecord[] | null,
  version: string,
  reloadedAt: number,
): ReloadCooldownRecord[] {
  const withoutSameVersion = (records ?? []).filter((record) => record.version !== version);
  const upserted = [...withoutSameVersion, { version, reloadedAt }];
  return upserted.slice(-MAX_RELOAD_COOLDOWN_RECORDS);
}

/**
 * sessionStorage に保存されたクールダウン記録(JSON文字列の配列)をパースする。
 *
 * Issue #634 より前のクライアントは、同じ目的のsessionStorageキーへ単一の
 * { version, reloadedAt } オブジェクトを書き込んでいた。ここで新旧の形式を
 * 両対応させる代わりに、page.tsx側でストレージキー自体を新バージョン用
 * ("twica-overlay-reload-v2")へ切り替えている(自動レビュー指摘: 同一キーを
 * 新旧コードで奪い合うと、ローリングデプロイの混在ウィンドウ中に同一タブが
 * 旧コードのビルドへ着地するたびクールダウン記録が単一オブジェクトへ巻き戻され
 * 続ける恐れがあった。sessionStorageはタブ単位で独立しているため「別タブが
 * 読む」ことはないが、「同一タブが旧コードのビルドへ着地する」ことは起こり
 * 得る)。キーを分けることで新コードは常に自分が書いた配列形式だけを読み、
 * 旧コードは自分の旧キーだけを読み書きするため、双方が干渉し合わない。
 * 旧キーへ残る単一オブジェクトのデータは新コードから一切参照されず無害に
 * 取り残されるだけで、そのユーザーの次回リロードが1回クールダウンなしで
 * 発生する(＝そのユーザーにとって初回リロードと同じ扱い)以外の影響はない。
 *
 * parsePollState と同様、以下のいずれかに該当する場合は例外を投げず null を
 * 返す(呼び出し側は「クールダウン記録なし」として扱い、安全側に倒れる):
 * - raw が null/undefined/空文字列
 * - JSON として parse できない(壊れたデータ)
 * - トップレベルが配列でない(上記の旧キー使用により、新キーの下に単一
 *   オブジェクトが書き込まれることは正常経路では起こらないが、汚染された
 *   sessionStorageに対する防御として配列以外は一律nullにする)
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

  if (!Array.isArray(parsed)) return null;

  const validEntries: ReloadCooldownRecord[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const candidate = entry as Record<string, unknown>;
    if (typeof candidate.version !== "string") continue;
    if (typeof candidate.reloadedAt !== "number") continue;
    validEntries.push({ version: candidate.version, reloadedAt: candidate.reloadedAt });
  }

  if (validEntries.length === 0) return null;

  // 自前の書き込み(upsertReloadCooldownRecord)は常に上限内に収まるが、
  // 外部からの汚染に備え読み取り側でも直近側だけへ切り詰める。
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
