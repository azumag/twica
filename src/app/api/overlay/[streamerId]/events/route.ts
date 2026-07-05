import { NextRequest, NextResponse } from "next/server";
import { and, asc, eq, gt } from "drizzle-orm";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { withRetry } from "@/lib/supabase/retry";
import { handleApiError, handleDatabaseError } from "@/lib/error-handler";
import {
  checkRateLimit,
  getRateLimitIdentifier,
  rateLimits,
} from "@/lib/rate-limit";
import { ERROR_MESSAGES } from "@/lib/constants";
import type { Rarity } from "@/types/database";
import type { ApiRateLimitResponse } from "@/types/api";
// Issue #571 (#570 パイロット踏襲): pg 直結の読み取り経路。
// getDb() は withDbRetry の queryFn 内で呼ぶ規約(src/lib/db/retry.ts 参照)。
import { getDb } from "@/lib/db/client";
import { isPgReadEnabled } from "@/lib/db/flags";
import { withDbRetry } from "@/lib/db/retry";
import { isPgMissingColumnError } from "@/lib/db/errors";
import {
  gachaHistory as gachaHistoryTable,
  cards as cardsTable,
} from "@/lib/db/schema";

interface RouteParams {
  params: Promise<{ streamerId: string }>;
}

interface OverlayHistoryCard {
  id: string;
  name: string;
  description: string | null;
  image_url: string | null;
  rarity: Rarity;
}

interface OverlayHistoryRow {
  id: string;
  event_id: string | null;
  redeemed_at: string;
  user_twitch_username: string | null;
  // Issue #591: migration 00070 で追加。デプロイ窓では未選択(下のフォールバック
  // クエリ)になりうるため undefined も許容する。
  reward_id?: string | null;
  cards: OverlayHistoryCard | OverlayHistoryCard[] | null;
}

/**
 * Issue #591: gacha_history.reward_id (migration 00070) が未デプロイのDBに
 * ローリングデプロイ中の新アプリコードが SELECT すると発生する読み取りエラーを
 * 検知する。書き込み経路の PGRST204 とは異なり、SELECT/ORDER/フィルタでの
 * 列欠落は PostgreSQL が直接 42703 ("column ... does not exist") を返す
 * (このモジュールでは書き込みは発生しないため 42703 が主だが、PostgREST の
 * スキーマキャッシュ経由のPGRST204も念のため許容する)。
 * collection-existence.ts の isMissingCollectionNameColumn 等と同じ判定パターン。
 */
function isMissingRewardIdColumnError(
  error: { message?: string; code?: string; details?: string; hint?: string } | null | undefined
): boolean {
  if (!error) return false;
  const text = [error.message, error.details, error.hint]
    .map((value) => String(value ?? ""))
    .join(" ");

  return (
    text.includes("reward_id") &&
    (error.code === "PGRST204" ||
      text.includes("does not exist") ||
      text.includes("schema cache"))
  );
}

const OVERLAY_HISTORY_SELECT_WITH_REWARD_ID =
  "id, event_id, redeemed_at, user_twitch_username, reward_id, cards(id, name, description, image_url, rarity)";
const OVERLAY_HISTORY_SELECT_WITHOUT_REWARD_ID =
  "id, event_id, redeemed_at, user_twitch_username, cards(id, name, description, image_url, rarity)";

function normalizeDateParam(value: string | null): string | null {
  if (!value) return null;

  const timestamp = Date.parse(value);
  if (Number.isFinite(timestamp)) {
    return new Date(timestamp).toISOString();
  }

  // Cloudflare/OBS combinations can send Postgres timestamps with
  // microseconds (6 fractional digits), which some runtimes reject.
  const match = value.match(
    /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/
  );
  if (!match) return null;

  const [, base, fraction = "", timezone] = match;
  const normalizedFraction = fraction.padEnd(3, "0").slice(0, 3);
  const normalized = `${base}.${normalizedFraction}${timezone}`;
  const normalizedTimestamp = Date.parse(normalized);
  return Number.isFinite(normalizedTimestamp)
    ? new Date(normalizedTimestamp).toISOString()
    : null;
}

function resolveCard(cards: OverlayHistoryRow["cards"]): OverlayHistoryCard | null {
  if (Array.isArray(cards)) {
    return cards[0] ?? null;
  }
  return cards;
}

// -----------------------------------------------------------------------------
// pg 直結経路 (#571, #570 パイロット踏襲)
//
// #570 で追加された src/lib/db/(flags/client/retry/errors) と、そのパイロット
// 適用箇所である src/lib/announcements.ts の getUnreadAnnouncementsPg を踏襲する。
// isPgReadEnabled() が true のときのみ以下のヘルパーが呼ばれ、フラグ未設定時
// (既定 'postgrest') は下の GET ハンドラの else 節(既存 supabase-js 実装、無変更)
// のみが実行される。
//
// redeemedAt の表現形式について(判断根拠):
// pg 直結は drizzle-orm/postgres-js が timestamp/timestamptz パーサをパススルーに
// 上書きするため、PG の ISO スタイルテキスト形式(例: "2026-03-10 12:34:56.123456+00"、
// スペース区切り・オフセットは分が0なら "+00" のみ)の文字列を返す。一方 PostgREST は
// ISO 8601 (例: "2026-03-10T12:34:56.123456+00:00"、T区切り)を返す
// (src/lib/db/client.ts の createHandle コメント、src/lib/announcements.ts の
// getUnreadAnnouncementsPg コメント参照)。
// この差がクライアントに影響するかを実際に確認した:
//   1. overlay クライアント(src/app/overlay/[streamerId]/page.tsx の
//      pollOverlayEvents)は event.redeemedAt を Date.parse() 経由でのみ消費し、
//      パース成功時は new Date(ms).toISOString() で正規化してから
//      pollCursorRef(次回リクエストの ?since= の値)に格納する。文字列としての
//      比較や画面への直接表示は一切行っていない。
//   2. Node(V8)で実地検証済み: Date.parse("2026-03-10 12:34:56.123456+00") は
//      2026-03-10T12:34:56.123Z 相当に正しくパースされる(PG の ISO スタイル
//      出力を V8 の緩やかな日付パーサが解釈できる)。PostgREST 形式・pg 直結
//      形式のどちらでパースしても同一時刻になる。
//   3. クライアントは受信した redeemedAt の形式に関わらず必ず toISOString()
//      (T区切り・Z終端)で再正規化してから since として送り返すため、pg 直結
//      経路に切り替わってもポーリングカーソルの単調性・往復互換は既存
//      (PostgREST)経路と同じ挙動になる。ミリ秒未満(マイクロ秒)の切り捨ては
//      両経路で等しく発生する既存の性質であり、本対応による新規回帰ではない。
// 以上より、redeemedAt は pg のテキスト形式のまま返し、追加の正規化ヘルパーは
// 導入しない(getUnreadAnnouncementsPg と同じ判断)。
//
// leftJoin + flat 列エイリアスについて:
// gacha_history.card_id は ON DELETE CASCADE (00071マイグレーション) のため
// 実運用では常に一致するカードが存在するが、既存の resolveCard は防御的に
// null card を許容しフィルタしている。この既存の防御的挙動を pg 経路でも
// 1:1 再現するため leftJoin を用い、cards 側の列が全て null(=一致行なし)かを
// card_id === null で判定する。ネストしたオブジェクト形式の select
// (例: { card: { id: cardsTable.id, ... } }) は使わず個々の列を flat に
// エイリアスする。理由: drizzle-orm の左外部結合時オブジェクト自動 null 化は
// バージョン依存の内部挙動に頼ることになり、実装意図が読み取りにくい。flat
// 列 + 明示的な null 判定のほうがテストしやすく既存 resolveCard の判定方法
// (単一オブジェクト or null)とも対応が取りやすい。
// -----------------------------------------------------------------------------

/** pg 直結クエリが返す flat な行の形状(reward_id の有無に関わらず共通) */
interface PgOverlayHistoryFlatRow {
  id: string;
  event_id: string | null;
  redeemed_at: string | null;
  user_twitch_username: string | null;
  // leftJoin の右側(cards)は不一致行で null になるため、スキーマ上は
  // notNull な列でも結果型は string | null になる(drizzle-orm の
  // JoinNullability による型ワイド。select.types.d.ts で確認済み)。
  card_id: string | null;
  card_name: string | null;
  card_description: string | null;
  card_image_url: string | null;
  card_rarity: string | null;
}

/**
 * pg 直結: reward_id 列を含む本来のクエリ。
 * supabase-js 版の OVERLAY_HISTORY_SELECT_WITH_REWARD_ID に対応する。
 */
async function fetchOverlayHistoryWithRewardIdPg(
  streamerId: string,
  since: string
): Promise<(PgOverlayHistoryFlatRow & { reward_id: string | null })[]> {
  const { db } = await getDb();
  return db
    .select({
      id: gachaHistoryTable.id,
      event_id: gachaHistoryTable.event_id,
      redeemed_at: gachaHistoryTable.redeemed_at,
      user_twitch_username: gachaHistoryTable.user_twitch_username,
      reward_id: gachaHistoryTable.reward_id,
      card_id: cardsTable.id,
      card_name: cardsTable.name,
      card_description: cardsTable.description,
      card_image_url: cardsTable.image_url,
      card_rarity: cardsTable.rarity,
    })
    .from(gachaHistoryTable)
    .leftJoin(cardsTable, eq(gachaHistoryTable.card_id, cardsTable.id))
    .where(
      and(
        eq(gachaHistoryTable.streamer_id, streamerId),
        gt(gachaHistoryTable.redeemed_at, since)
      )
    )
    .orderBy(asc(gachaHistoryTable.redeemed_at))
    .limit(10);
}

/**
 * pg 直結: reward_id 列を含まないフォールバッククエリ(Issue #591 デプロイ窓対応)。
 * supabase-js 版の OVERLAY_HISTORY_SELECT_WITHOUT_REWARD_ID に対応する。
 *
 * reward_id を select オブジェクトから丸ごと省いた別関数として定義する理由:
 * supabase-js 版が「select() のリテラル文字列から列数の異なる2つの非互換な
 * Row 型が推論される」ため2つの定数に分けているのと同じ理由で、Drizzle の
 * select({...}) も渡したオブジェクトリテラルの形から結果型を推論するため、
 * 条件分岐で選択列を動的に組み立てるより2つの独立した関数に分けたほうが
 * 型安全性が高く可読性も良い。
 */
async function fetchOverlayHistoryWithoutRewardIdPg(
  streamerId: string,
  since: string
): Promise<PgOverlayHistoryFlatRow[]> {
  const { db } = await getDb();
  return db
    .select({
      id: gachaHistoryTable.id,
      event_id: gachaHistoryTable.event_id,
      redeemed_at: gachaHistoryTable.redeemed_at,
      user_twitch_username: gachaHistoryTable.user_twitch_username,
      card_id: cardsTable.id,
      card_name: cardsTable.name,
      card_description: cardsTable.description,
      card_image_url: cardsTable.image_url,
      card_rarity: cardsTable.rarity,
    })
    .from(gachaHistoryTable)
    .leftJoin(cardsTable, eq(gachaHistoryTable.card_id, cardsTable.id))
    .where(
      and(
        eq(gachaHistoryTable.streamer_id, streamerId),
        gt(gachaHistoryTable.redeemed_at, since)
      )
    )
    .orderBy(asc(gachaHistoryTable.redeemed_at))
    .limit(10);
}

/**
 * pg 直結クエリの flat 行を、既存 supabase-js 経路と共通の OverlayHistoryRow
 * 形状(cards が単一オブジェクトまたは null のネスト)へ変換する。
 * これにより GET ハンドラ末尾のイベント整形(resolveCard 経由のマッピング・
 * フィルタ)を両経路で完全に共有できる(ロジックの重複を避ける)。
 */
function toOverlayHistoryRow(
  row: PgOverlayHistoryFlatRow,
  rewardId: string | null
): OverlayHistoryRow {
  return {
    id: row.id,
    event_id: row.event_id,
    // where 句の gt(redeemed_at, since) を満たす行は NULL ではあり得ないため
    // 実質非 null(既存 supabase-js 版の OverlayHistoryRow 型と同じ前提。
    // スキーマ上 nullable なのは leftJoin と無関係にこの列自体が NOT NULL
    // 制約を持たないため)。
    redeemed_at: row.redeemed_at as string,
    user_twitch_username: row.user_twitch_username,
    reward_id: rewardId,
    cards:
      row.card_id === null
        ? null
        : {
            id: row.card_id,
            name: row.card_name as string,
            description: row.card_description,
            image_url: row.card_image_url,
            rarity: row.card_rarity as Rarity,
          },
  };
}

/**
 * pg 版: 42703(列欠落)のうち reward_id 列の欠落に限定して判定する。
 *
 * 自己レビュー指摘への対応: isPgMissingColumnError() 単体は列名を問わず
 * true になるため、万一 gacha_history/cards の別列が欠落する事態(現行
 * スキーマでは他列は初版 migration 00001 由来のため考えにくいが)が起きた
 * 場合でも「reward_id 列欠落」と誤認してフォールバッククエリへ余計に
 * 1往復してしまう。supabase-js 版の isMissingRewardIdColumnError(エラー
 * メッセージに "reward_id" を含むかで絞り込む)と同じ精度に揃えることで、
 * フォールバックの発火条件をより厳密にする。
 */
function isMissingRewardIdColumnErrorPg(error: unknown): boolean {
  if (!isPgMissingColumnError(error)) return false;
  // 先行レビュー指摘への対応: supabase-js 版と異なり message しか見ないが、postgres.js の 42703 は PostgreSQL 本体が生成し列名を必ず message に含む(PostgREST 経由のように details/hint 側に情報が回る余地が無い)ため、message のみの判定で実害は無い。
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === "string" && message.includes("reward_id");
}

/**
 * pg 直結: overlay ポーリング用の gacha_history + cards 取得。
 * Issue #591 相当のデプロイ窓フォールバック(reward_id 列未デプロイ)を含む。
 *
 * 冪等な読み取りのため withDbRetry(..., { idempotent: true }) でラップする
 * (getUnreadAnnouncementsPg と同じ規約)。
 *
 * maxRetries: 1 について(自己レビュー指摘への対応、実装計画からの逸脱):
 * このエンドポイントの既存 supabase-js 実装(下の GET ハンドラの else 節)は
 * withRetry(..., { maxRetries: 1 })を明示指定しており、getUnreadAnnouncementsPg
 * (withDbRetry のデフォルト値[100,300,1000]ms・最大3回リトライを使う)とは
 * 異なる、このエンドポイント固有のチューニングである。3秒間隔でポーリング
 * される公開エンドポイントで DB 一時障害時にリトライ上限を既定の3回のままに
 * すると、1リクエストあたり最大約1.4秒(かつフォールバック分も加わると
 * 最大約2.8秒)応答が遅延し、多数の overlay クライアントからの同時ポーリングで
 * Workers 側の滞留を招きうる。既存 postgrest 経路と同じ「1回だけ再試行」に
 * 揃えることで、レイテンシ特性を含めた挙動不変の要件を満たす。
 */
async function getOverlayHistoryRowsPg(
  streamerId: string,
  since: string
): Promise<OverlayHistoryRow[]> {
  try {
    const rows = await withDbRetry(
      () => fetchOverlayHistoryWithRewardIdPg(streamerId, since),
      "overlayEvents(pg)",
      { idempotent: true, maxRetries: 1 }
    );
    return rows.map((row) => toOverlayHistoryRow(row, row.reward_id));
  } catch (error) {
    if (!isMissingRewardIdColumnErrorPg(error)) {
      throw error;
    }
    // Issue #591 デプロイ窓フォールバック(pg版): gacha_history.reward_id
    // (migration 00070)が未デプロイのDBに新アプリコードがSELECTすると
    // 42703 undefined_column が発生する。列を含めない別クエリへ1回だけ
    // フォールバックし、rewardId は null(既存の rarity/all ルールへの
    // フォールバック挙動)として扱う。supabase-js 版の同名フォールバックと
    // 同じ設計判断(コメント参照)。
    const rows = await withDbRetry(
      () => fetchOverlayHistoryWithoutRewardIdPg(streamerId, since),
      "overlayEvents(pg):reward-id-fallback",
      { idempotent: true, maxRetries: 1 }
    );
    return rows.map((row) => toOverlayHistoryRow(row, null));
  }
}

/**
 * GET /api/overlay/[streamerId]/events
 *
 * Public polling fallback for OBS overlays. Realtime remains the primary path,
 * but this endpoint lets overlays recover when Supabase Realtime rejects public
 * channel joins or a browser source loses its WebSocket for a long period.
 */
export async function GET(
  request: NextRequest,
  { params }: RouteParams
): Promise<NextResponse> {
  try {
    const { streamerId } = await params;
    if (!streamerId) {
      return NextResponse.json(
        { error: ERROR_MESSAGES.STREAMER_ID_REQUIRED },
        { status: 400 }
      );
    }

    const { searchParams } = new URL(request.url);
    const since = normalizeDateParam(searchParams.get("since"));
    if (!since) {
      return NextResponse.json(
        { error: "Invalid since parameter" },
        { status: 400 }
      );
    }

    const identifier = await getRateLimitIdentifier(request);
    const rateLimitResult = await checkRateLimit(
      rateLimits.overlayEventsGet,
      identifier
    );

    if (!rateLimitResult.success) {
      return NextResponse.json<ApiRateLimitResponse>(
        {
          error: ERROR_MESSAGES.RATE_LIMIT_EXCEEDED,
          retryAfter:
            (rateLimitResult.reset || 0) - Math.floor(Date.now() / 1000),
        },
        {
          status: 429,
          headers: {
            "X-RateLimit-Limit": String(rateLimitResult.limit),
            "X-RateLimit-Remaining": String(rateLimitResult.remaining),
            "X-RateLimit-Reset": String(rateLimitResult.reset),
          },
        }
      );
    }

    // #571 (#570 パイロット踏襲): DB アクセス部分のみをフラグで分岐する。
    // フラグ未設定(既定 'postgrest')時は else 節の既存 supabase-js 実装が
    // そのまま実行され、挙動は完全に不変(1文字も変更していない。再インデント
    // のみ)。overlayHistoryRows へ集約後の整形処理(events 構築)は両経路で
    // 完全に共有する(下記、resolveCard 経由のロジックは無変更)。
    let overlayHistoryRows: OverlayHistoryRow[];

    if (isPgReadEnabled()) {
      try {
        overlayHistoryRows = await getOverlayHistoryRowsPg(streamerId, since);
      } catch (pgError) {
        // 既存 postgrest 分岐の非列欠落エラーと同じ扱い(handleDatabaseError)に
        // 揃える。汎用 catch(下の handleApiError)に落とすと
        // ERROR_MESSAGES.INTERNAL_ERROR('Internal server error')という別文言に
        // なり、DB起因エラーの応答本文が経路によって変わってしまうため。
        return handleDatabaseError(pgError, "Overlay Events API");
      }
    } else {
      const supabaseAdmin = getSupabaseAdmin();
      let { data, error } = await withRetry(
        () =>
          supabaseAdmin
            .from("gacha_history")
            .select(OVERLAY_HISTORY_SELECT_WITH_REWARD_ID)
            .eq("streamer_id", streamerId)
            .gt("redeemed_at", since)
            .order("redeemed_at", { ascending: true })
            .limit(10),
        "overlayEvents",
        { maxRetries: 1 }
      );

      // Issue #591 デプロイ窓フォールバック: gacha_history.reward_id (migration 00070)
      // がまだ本番DBに適用されていない状態で新アプリコードがSELECTすると読み取り
      // エラーになる。列を含めない従来のクエリへ1回だけ再試行し、rewardId は
      // null(=既存の rarity/all ルールへのフォールバック挙動)として扱う。
      // isMissingCollectionNameColumn 等(collection-existence.ts)と同じ
      // 「列剥がして再試行」パターン。
      if (error && isMissingRewardIdColumnError(error)) {
        const fallback = await withRetry(
          () =>
            supabaseAdmin
              .from("gacha_history")
              .select(OVERLAY_HISTORY_SELECT_WITHOUT_REWARD_ID)
              .eq("streamer_id", streamerId)
              .gt("redeemed_at", since)
              .order("redeemed_at", { ascending: true })
              .limit(10),
          "overlayEvents:reward-id-fallback",
          { maxRetries: 1 }
        );
        // supabase-js は select() の*リテラル*文字列からRow型を推論するため、列数が
        // 異なる2つのSELECTは互換性の無い別々の型になる(gacha.ts の
        // executeGacha 内 max_issuance_count フォールバックと同じ制約)。fallback行に
        // reward_id: null を明示的に補って、上のwith-reward-id型と構造的に一致させる。
        data = fallback.data?.map((row) => ({ ...row, reward_id: null })) ?? null;
        error = fallback.error;
      }

      if (error) {
        return handleDatabaseError(error, "Overlay Events API");
      }

      overlayHistoryRows = (data ?? []) as OverlayHistoryRow[];
    }

    const events = overlayHistoryRows
      .map((row) => {
        const card = resolveCard(row.cards);
        if (!card) return null;
        return {
          id: row.id,
          eventId: row.event_id,
          redeemedAt: row.redeemed_at,
          userTwitchUsername: row.user_twitch_username ?? "Unknown",
          // Issue #591: ポーリング経路でも報酬別効果音ルールが評価できるよう、
          // gacha_history.reward_id をそのまま公開する。列未デプロイ時
          // (上のフォールバック後)は常に undefined ?? null = null になり、
          // 従来どおり rarity/all ルールへ安全にフォールバックする。
          rewardId: row.reward_id ?? null,
          card,
        };
      })
      .filter((event): event is NonNullable<typeof event> => event !== null);

    // Issue #569: overlay クライアントのバージョン不一致検出用。既存キー(events)は
    // そのままに overlayVersion を追加するだけなので後方互換(未知キーは無視される)。
    // NEXT_PUBLIC_OVERLAY_VERSION は next.config.ts の env 設定でビルド時に
    // インライン化される値(未設定になるケースは無いはずだが、念のため 'dev' にフォールバック)。
    return NextResponse.json({
      events,
      overlayVersion: process.env.NEXT_PUBLIC_OVERLAY_VERSION ?? "dev",
    });
  } catch (error) {
    return handleApiError(error, "Overlay Events API");
  }
}
