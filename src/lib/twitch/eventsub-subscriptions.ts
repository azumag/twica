import "server-only";

import { fetchTwitchApi } from "@/lib/twitch/app-token";

/**
 * Twitch EventSub サブスクリプション監視の共通ヘルパー (Issue #540)。
 *
 * `GET /helix/eventsub/subscriptions` のページネーション取得ロジックは既に
 * `src/app/api/twitch/eventsub/subscribe/route.ts` /
 * `src/app/api/twitch/eventsub/debug/route.ts` /
 * `src/app/api/twitch/channel-point-bootstrap/route.ts` の3箇所で個別に実装
 * されている（それぞれ user_id 絞り込みの有無・返す型が微妙に異なるため、既存分の
 * 統合は本 issue のスコープ外。YAGNI: 動いている既存コードを不要にリスクへ晒さない）。
 * ただし本 issue で新規に追加する「全サブスクリプションの健全性監視」は、
 * 既存のどの route にも属さない新規の関心事なので、これ以上コピーを増やさず
 * ここへ集約する。
 */

const TWITCH_API_URL = "https://api.twitch.tv/helix";

/** Helix EventSub サブスクリプションのレスポンス形状（監視に必要な項目のみ）。 */
export interface EventSubSubscriptionSummary {
  id: string;
  status: string;
  type: string;
  condition: {
    broadcaster_user_id?: string;
    reward_id?: string;
    to_broadcaster_user_id?: string;
  };
  transport: { method: string; callback: string };
  created_at: string;
}

/**
 * このアプリ(Twitch app)が保有する全 EventSub サブスクリプションを、
 * ページネーションしながら取得する。app access token（`fetchTwitchApi`が
 * 自動付与・401時1回だけ再発行してリトライ）を使うため、streamerごとの
 * ユーザートークンは不要。
 *
 * @throws 非2xxレスポンスの場合（呼び出し元のroute handlerがcatchして
 *   汎用エラーとして扱う想定。db-health/route.tsと同様、詳細は呼び出し元で
 *   ログにのみ残しレスポンスへは汎用メッセージを返す）。
 */
export async function listAllEventSubSubscriptions(): Promise<EventSubSubscriptionSummary[]> {
  const all: EventSubSubscriptionSummary[] = [];
  let cursor: string | undefined;

  do {
    const url = cursor
      ? `${TWITCH_API_URL}/eventsub/subscriptions?after=${cursor}`
      : `${TWITCH_API_URL}/eventsub/subscriptions`;

    const response = await fetchTwitchApi(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch EventSub subscriptions: ${response.status}`);
    }

    const data = (await response.json()) as {
      data: EventSubSubscriptionSummary[];
      pagination?: { cursor?: string };
    };
    all.push(...data.data);
    cursor = data.pagination?.cursor;
  } while (cursor);

  return all;
}

/**
 * webhook transport の EventSub サブスクリプションが「生きている」とみなせる
 * status の集合。
 *
 * - `enabled`: 正常稼働中。
 * - `webhook_callback_verification_pending`: 作成直後、Twitch側のコールバック
 *   検証が完了するまでの一過性の状態（通常は数秒〜長くて数十秒で解決する）。
 *   これを unhealthy に含めると、購読作成直後にたまたま健全性チェックの
 *   cronが走った場合に誤検知してしまう。
 *
 * 上記2つ・および下記 EXPECTED_USER_INITIATED_EVENTSUB_STATUSES 以外の
 * status（`webhook_callback_verification_failed` /
 * `notification_failures_exceeded` / `moderator_removed` /
 * `chat_user_banned` / `version_removed` / `beta_maintenance` 等）は
 * いずれも Twitch 側でサブスクリプションが終端状態に落ちたことを示し、
 * 放置しても自然回復しない。この状態のまま気づかずにいると、該当streamerの
 * 視聴者はガチャ交換ボタンを押してもチャンネルポイントだけ消費されカードが
 * 付与されない、という無音の失敗が起き続ける（issue #540 背景の #527 参照）。
 */
const HEALTHY_OR_TRANSIENT_EVENTSUB_STATUSES = new Set([
  "enabled",
  "webhook_callback_verification_pending",
]);

/**
 * ユーザー起因で「期待される」EventSub 終端状態の集合。
 *
 * `src/app/api/twitch/eventsub/route.ts` の revocation webhook ハンドラは
 * Issue #285 の方針により、この2つを「ユーザー起因のrevocationは期待される
 * 挙動であり bug ではない」として reportError（GitHub Issue化）の対象外に
 * している（同route.tsの EXPECTED_REVOCATIONS 参照）。健全性監視も同じ判定
 * 基準を使わないと、#285 で意図的に黙らせている状態を本機能が再びアラート化
 * してしまう退行になる（PR #1009 レビュー指摘）。加えてこれらは配信者が
 * 自分の意思でapp連携を解除した結果であり、5分毎のcronで検知され続ける限り
 * 恒久的に unhealthy のままになる — インフラ障害と違って「対応すれば直る」
 * 性質の状態ではないため、繰り返しアラートを鳴らす価値が薄いことも #285 と
 * 同じ理由。
 *
 * ここへ値を追加・変更する場合は eventsub/route.ts の EXPECTED_REVOCATIONS
 * とドリフトしないよう、必ず両方を同時に確認すること（2箇所とも同じ配列
 * リテラルを持つ独立実装であり、片方を lib 側の import へ寄せる統合は
 * eventsub/route.ts 側の既存動作へ手を入れることになるため、本PRではあえて
 * 行わない。代わりに、wrangler.toml crons と EVENTSUB_AUTO_DRAIN_CRON の
 * ドリフト検知テスト（tests/unit/error-reporter-worker.test.ts）と同じ
 * 「ソースをreadFileSync + 正規表現で読んで値を突き合わせる」方式の契約
 * テストを tests/unit/twitch-eventsub-subscriptions.test.ts に用意し、
 * どちらかだけが変更されたらテストが赤くなるようにしている）。
 */
export const EXPECTED_USER_INITIATED_EVENTSUB_STATUSES = new Set([
  "authorization_revoked",
  "user_removed",
]);

/**
 * 上記の健全/一過性/期待される終端状態のいずれでもない status を unhealthy と
 * 判定する。
 */
export function isUnhealthyEventSubStatus(status: string): boolean {
  if (HEALTHY_OR_TRANSIENT_EVENTSUB_STATUSES.has(status)) return false;
  if (EXPECTED_USER_INITIATED_EVENTSUB_STATUSES.has(status)) return false;
  return true;
}
