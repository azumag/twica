import { cache } from "react";
import { unstable_cache } from "next/cache";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { logger } from "@/lib/logger";
import { normalizeDropRate } from "@/lib/card-utils";
import { reportError } from "@/lib/sentry/error-handler";
import { withRetry } from "@/lib/supabase/retry";
import { logPerf, perfStart } from "@/lib/perf";
// ---------------------------------------------------------------------------
// #571: pg 直結経路 (DB_DRIVER=pg-read/pg) 用の import。
// フラグ未設定時（既定 'postgrest'）は isPgReadEnabled() が false を返すため
// getDb() は一切呼ばれず、既存の supabase-js 経路が従来どおり実行される。
// count は既存コードの `const { count } = await ...` 分割代入と名前が衝突する
// ため countRows に alias する。
// #573 で読み取り RPC（get_user_card_counts 等）の pg 直結分岐にも同じ基盤を使う。
// ---------------------------------------------------------------------------
import {
  and,
  asc,
  count as countRows,
  desc,
  eq,
  getTableColumns,
  gte,
  ilike,
  inArray,
  lt,
} from "drizzle-orm";
import { getDb, type DbHandle } from "@/lib/db/client";
import { isPgFunctionNotFoundError, isPgMissingColumnError } from "@/lib/db/errors";
import { isPgReadEnabled } from "@/lib/db/flags";
import { withDbRetry } from "@/lib/db/retry";
// Issue #685: cards テーブルの本番未デプロイ8列（card_number/hp/atk/def/spd/
// skill_type/skill_name/skill_power、#625 参照）に対する SELECT フォールバック。
// src/app/api/cards/route.ts の fetchCardsFromDBPg で確立したパターン（無指定
// select → 列欠落エラー検知 → CARDS_SAFE_COLUMNS で再試行）を本モジュールにも
// 適用する。詳細は cards-safe-columns.ts のコメント参照。
import { CARDS_SAFE_COLUMNS, withCardsBattleColumnFallback } from "@/lib/db/cards-safe-columns";
// schema のテーブル名（cards / streamers 等）は本モジュールのローカル変数名・
// 型名と紛らわしいため、Table サフィックスを付けて import する
// （announcements.ts パイロットと同じ規約）
import {
  cards as cardsTable,
  collectionCompletions as collectionCompletionsTable,
  gachaHistory as gachaHistoryTable,
  streamers as streamersTable,
  userCards as userCardsTable,
  users as usersTable,
} from "@/lib/db/schema";
// Issue #557: デプロイ窓 (00064 未適用) の collection_name 列欠落検知に再利用。
// 既存ヘルパは "collection_name" 文言でゲートしており、collection_completions
// の同名列にもそのまま一致する。
import { isMissingCollectionNameColumn } from "@/lib/collections/collection-existence";
import type { Card, Streamer, GachaHistory, Database } from "@/types/database";

interface CardWithDetails extends Card {
  streamer: Streamer;
  count: number;
}

interface GachaHistoryWithCard extends GachaHistory {
  cards: Card;
}

/**
 * getStreamerData の Drizzle（pg 直結）実装 (#571)
 *
 * PostgREST 実装との対応:
 * - `streamers.*, cards!cards_streamer_id_fkey(*)` の埋め込み1リクエストを、
 *   streamers LEFT JOIN cards の1クエリで置き換える（往復回数のパリティ）。
 *   JOIN 条件 cards.streamer_id = streamers.id は FK 制約
 *   cards_streamer_id_fkey が表す関係そのものであり、PostgREST の埋め込みヒント
 *   （PGRST201 回避）と同じリレーションを SQL で明示していることになる。
 * - PostgREST の max-rows(1000) は「トップレベル行」にのみ適用され、埋め込み
 *   配列は打ち切られない。よってこの JOIN にも LIMIT は付けない（カード全件）。
 * - streamers.twitch_user_id は UNIQUE（migration 00001）のため streamer は
 *   最大1行。JOIN の複数行はすべて同一 streamer で、カードだけが異なる。
 * - .maybeSingle() のエラー（およびクエリ失敗全般）は既存実装が分割代入で
 *   握り潰して null 扱いにしているため、pg 版も catch して null を返す
 *   （外部挙動のパリティ。ログだけは切替検証のため残す）。
 *
 * 日付の表現形式（#688 で更新。パイロット announcements.ts と同様）: pg 直結・
 * PostgREST いずれも ISO 8601 を返す。pg 直結は元々 PG テキスト形式
 * （'2026-03-10 12:00:00.123456+00'）で返していたが、src/lib/db/client.ts の
 * installIsoTimestampParsers() が接続確立時に ISO 8601 へ正規化するパーサへ
 * 差し替えている。本モジュールの消費側はすべて new Date() / Date.parse 経由で
 * 日付を扱うため正規化前後どちらの形式でも影響はなかったが、正規化後は文字列
 * 表現も PostgREST 経路と一致する（文字列を直接パースする消費側を追加する場合は
 * 表現が一致していることを前提にしてよい）。他の xxxPg も同様。
 */
async function getStreamerDataPg(
  twitchUserId: string
): Promise<{ streamer: Streamer; cards: Card[] } | null> {
  // Issue #685: card: cardsTable のネスト select は cards の全列（本番未デプロイ
  // 8列を含む）を要求する。まず無指定で試み、列欠落エラーなら CARDS_SAFE_COLUMNS
  // へ差し替えて再試行する（cards-safe-columns.ts 参照）。
  async function selectStreamerWithCards(useSafeColumns: boolean) {
    return withDbRetry(
      async () => {
        // 規約: getDb() は queryFn の中で呼ぶ（リクエストスコープ破棄からの
        // 回復にはクライアント再取得が必要。src/lib/db/retry.ts 参照）
        const { db } = await getDb();
        return db
          .select({
            streamer: streamersTable,
            card: useSafeColumns ? CARDS_SAFE_COLUMNS : cardsTable,
          })
          .from(streamersTable)
          .leftJoin(cardsTable, eq(cardsTable.streamer_id, streamersTable.id))
          .where(eq(streamersTable.twitch_user_id, twitchUserId));
      },
      "getStreamerData",
      { idempotent: true },
    );
  }

  try {
    const rows = await withCardsBattleColumnFallback(selectStreamerWithCards);

    if (rows.length === 0) return null;

    // LEFT JOIN なのでカード0枚でも streamer 行は1行返る（card は null）。
    // PostgREST の cards: [] と同じく空配列に落とす。
    // ソートは既存実装と同一の JS ソート（created_at 降順）。
    // Drizzle スキーマの行は Card 型に無い生成カラム rarity_order も含むが、
    // PostgREST の `cards(*)` も実 DB の全列（rarity_order 含む）を返すため
    // むしろ形状は一致する。型だけ既存の戻り値型に合わせてキャストする
    // （値の変換はしない）。
    const cards = normalizeDropRate(
      rows.flatMap((row) => (row.card ? [row.card as unknown as Card] : []))
    ).sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    );

    // 既存実装は `{ cards: _cardsNested, ...streamerData }` でネストを除いた
    // streamer 列のみを返す。pg 版の streamer 行は最初からネストを含まない。
    const streamer = rows[0].streamer as unknown as Streamer;
    return { streamer, cards };
  } catch (error) {
    // 既存実装はエラー時に streamer=null → return null（呼び出し側は
    // /dashboard へのリダイレクト等で扱う）。同じ外部挙動に合わせる。
    logger.error("Error in getStreamerData (pg)", { error });
    return null;
  }
}

/**
 * Get streamer data with cards - cached per request
 * Single query using Supabase relations to reduce network round-trips
 *
 * リクエストごとにキャッシュされる配信者データとカードの取得
 * Supabaseのリレーションを使用して1回のクエリで取得し、ネットワーク往復を削減
 */
export const getStreamerData = cache(async (twitchUserId: string) => {
  // #571: DB_DRIVER=pg-read/pg のときのみ Drizzle 直結経路へ切り替える。
  // フラグ未設定時は素通りし、以下の既存 supabase-js 実装が従来どおり実行される。
  if (isPgReadEnabled()) {
    return getStreamerDataPg(twitchUserId);
  }

  const supabaseAdmin = getSupabaseAdmin();

  // Single query: get streamer with their cards using foreign key relation
  // 1回のクエリ: 外部キーリレーションを使用して配信者とカードを取得
  //
  // 埋め込みは必ず FK 制約名 cards_streamer_id_fkey を明示する。
  // migration 00051 で追加した card_owner_stats が streamers(id) と cards(id) の
  // 双方を参照する中間テーブルとなり、PostgREST が streamers→cards を
  // (1) cards.streamer_id 経由の直接リレーション
  // (2) card_owner_stats 経由の many-to-many リレーション
  // の2通りに解決できてしまう。ヒントなしの `cards (*)` は曖昧と判定され
  // PGRST201 (Could not embed because more than one relationship was found)
  // でクエリ全体が失敗し、streamer が null になって配信者が
  // カード管理/設定ページから /dashboard へ誤リダイレクトされていた。
  //
  // Always disambiguate the embed via the FK constraint name. Migration 00051's
  // card_owner_stats references both streamers and cards, so PostgREST finds two
  // possible streamers→cards relationships (direct FK vs. m2m junction) and an
  // un-hinted `cards (*)` fails with PGRST201, breaking these pages.
  const { data: streamer } = await supabaseAdmin
    .from("streamers")
    .select(`
      *,
      cards!cards_streamer_id_fkey (*)
    `)
    .eq("twitch_user_id", twitchUserId)
    .maybeSingle();

  if (!streamer) return null;

  // Extract and sort cards (newest first)
  // Supabaseのリレーション型はdrop_rateがunknownになるため、Card[]にキャストしてから正規化
  const cards = normalizeDropRate((streamer.cards || []) as Card[])
    .sort((a, b) =>
      new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    );

  // Return without the nested cards to match expected interface
  // 期待されるインターフェースに合わせてネストされたcardsを除外して返す
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { cards: _cardsNested, ...streamerData } = streamer;
  return { streamer: streamerData, cards };
})

/**
 * getStreamerDataPaginated の Drizzle（pg 直結）実装 (#571)
 *
 * PostgREST 実装との対応（3クエリ構成をそのまま踏襲）:
 * 1. streamers: .maybeSingle() 相当。twitch_user_id は UNIQUE のため LIMIT 1 で
 *    0行 → null / 1行 → その行、という同じ外部挙動になる。
 * 2. cards の総数: `{ count: "exact", head: true }` 相当を COUNT(*) で取得。
 * 3. cards のページ: `.range(offset, offset + perPage - 1)` は
 *    LIMIT perPage OFFSET offset と等価。
 *
 * エラー時の挙動は既存実装（分割代入でエラーを握り潰す）に合わせ、クエリ単位で
 * catch して同じフォールバック値に落とす:
 *   streamer 失敗 → null（関数全体が null）/ count 失敗 → 0 / cards 失敗 → []
 */
async function getStreamerDataPaginatedPg(
  twitchUserId: string,
  page: number,
  perPage: number
): Promise<{
  streamer: Streamer;
  cards: Card[];
  pagination: { page: number; perPage: number; total: number; totalPages: number };
} | null> {
  const start = Date.now();

  let streamer: Streamer | null;
  try {
    const rows = await withDbRetry(
      async () => {
        const { db } = await getDb();
        return db
          .select()
          .from(streamersTable)
          .where(eq(streamersTable.twitch_user_id, twitchUserId))
          .limit(1);
      },
      "getStreamerDataPaginated(streamer)",
      { idempotent: true },
    );
    // Drizzle 行は NULL 制約の型差（DDL 準拠）があるが値は同一のため、既存の
    // 戻り値型に合わせるキャストのみ行う（値の変換はしない）。
    streamer = (rows[0] ?? null) as unknown as Streamer | null;
  } catch (error) {
    logger.error("Error in getStreamerDataPaginated (pg:streamer)", { error });
    streamer = null;
  }

  if (!streamer) return null;
  // クロージャ内での TS null 絞り込みを保つため id を確定させる
  const streamerId = streamer.id;

  let totalCount = 0;
  try {
    totalCount = await withDbRetry(
      async () => {
        const { db } = await getDb();
        const result = await db
          .select({ count: countRows() })
          .from(cardsTable)
          .where(eq(cardsTable.streamer_id, streamerId));
        return result[0]?.count ?? 0;
      },
      "getStreamerDataPaginated(count)",
      { idempotent: true },
    );
  } catch (error) {
    // 既存実装は count エラー時 null → `totalCount || 0` で 0 扱い
    logger.error("Error in getStreamerDataPaginated (pg:count)", { error });
    totalCount = 0;
  }

  const offset = (page - 1) * perPage;
  let cards: Card[] = [];
  // Issue #685: 無指定 select() は cards の本番未デプロイ8列を要求する。
  // 列欠落エラーなら CARDS_SAFE_COLUMNS へ差し替えて再試行する。
  async function selectCards(useSafeColumns: boolean) {
    return withDbRetry(
      async () => {
        const { db } = await getDb();
        const query = useSafeColumns ? db.select(CARDS_SAFE_COLUMNS) : db.select();
        return query
          .from(cardsTable)
          .where(eq(cardsTable.streamer_id, streamerId))
          .orderBy(desc(cardsTable.created_at))
          .limit(perPage)
          .offset(offset);
      },
      "getStreamerDataPaginated(cards)",
      { idempotent: true },
    );
  }
  try {
    const rows = await withCardsBattleColumnFallback(selectCards);
    cards = rows as unknown as Card[];
  } catch (error) {
    // 既存実装は cards エラー時 null → `cards || []` で [] 扱い
    logger.error("Error in getStreamerDataPaginated (pg:cards)", { error });
    cards = [];
  }

  logger.info(`[Perf] getStreamerDataPaginated: ${Date.now() - start}ms (page ${page}, ${cards.length} cards)`);

  return {
    streamer,
    cards,
    pagination: {
      page,
      perPage,
      total: totalCount,
      totalPages: Math.ceil(totalCount / perPage),
    },
  };
}

/**
 * Get streamer data with paginated cards
 * サーバーサイドページング対応の配信者データとカード取得
 */
export const getStreamerDataPaginated = cache(async (
  twitchUserId: string,
  page: number = 1,
  perPage: number = 8
) => {
  // #571: pg 直結経路（フラグ未設定時は素通り。getStreamerDataPg 参照）
  if (isPgReadEnabled()) {
    return getStreamerDataPaginatedPg(twitchUserId, page, perPage);
  }

  const supabaseAdmin = getSupabaseAdmin();
  const start = Date.now();

  // Get streamer first
  // まず配信者を取得
  const { data: streamer } = await supabaseAdmin
    .from("streamers")
    .select("*")
    .eq("twitch_user_id", twitchUserId)
    .maybeSingle();

  if (!streamer) return null;

  // Get total count of cards for this streamer
  // この配信者のカード総数を取得
  const { count: totalCount } = await supabaseAdmin
    .from("cards")
    .select("*", { count: "exact", head: true })
    .eq("streamer_id", streamer.id);

  // Get paginated cards with ordering
  // ページネーション付きでカードを取得（新しい順）
  const offset = (page - 1) * perPage;
  const { data: cards } = await supabaseAdmin
    .from("cards")
    .select("*")
    .eq("streamer_id", streamer.id)
    .order("created_at", { ascending: false })
    .range(offset, offset + perPage - 1);

  logger.info(`[Perf] getStreamerDataPaginated: ${Date.now() - start}ms (page ${page}, ${cards?.length || 0} cards)`);

  return {
    streamer,
    cards: cards || [],
    pagination: {
      page,
      perPage,
      total: totalCount || 0,
      totalPages: Math.ceil((totalCount || 0) / perPage),
    },
  };
})

/**
 * pg 直結経路の RPC エラーを PostgREST .rpc() の error と同じ「code + message」
 * 形状へ正規化するための最小型 (#573)。postgres.js はエラーを throw するため、
 * 既存コードの `rpcError.code === "42883"` / `rpcError.message` 分岐を両経路で
 * 共有するにはこの形への詰め替えが必要（gacha.ts の GachaRpcDriverError と同じ設計）。
 * code を optional にしているのは、接続断系(CONNECTION_CLOSED 等)や非 Error
 * オブジェクトが throw された場合に SQLSTATE が存在しないため。
 */
interface DashboardRpcDriverError {
  code?: string;
  message: string;
}

/**
 * 読み取り RPC を pg 直結(postgres.js)で実行し、PostgREST .rpc() と同一の
 * { data, error } 形状へ正規化して返す共通ヘルパー (#573)。
 *
 * 本モジュールの RPC 呼び出し（get_user_card_counts / get_gacha_users_for_streamer /
 * get_gacha_drop_stats / get_channel_point_usage_stats / get_card_owner_stats）は
 * すべて RETURNS JSONB のため、行集合展開（select * from fn(...)）は不要で、
 * スカラー SELECT + rows[0].result で PostgREST .rpc() の data と同一形状の値が
 * 得られる（postgres.js は fetch_types:false でも json/jsonb の組み込みパーサで
 * JS 値化する。根拠は gacha.ts executeGachaTransactionRpcPg の doc コメント参照）。
 *
 * gacha.ts executeGachaTransactionRpcPg と同じく、分岐は「RPC を実行して
 * { data, error } を得る」部分だけに絞る設計: この形へ正規化することで、直後の
 * 既存エラー分岐（42883 → 警告ログ + 既存 postgrest フォールバック、その他 →
 * reportError + 既存フォールバック）と成功時のパース処理を両経路で完全に共有し、
 * 経路によって外部挙動が変わる余地を分岐点1箇所に閉じ込める。
 *
 * 42883 (undefined_function) = RPC 未デプロイのデプロイ窓。isPgFunctionNotFoundError
 * を明示的に使い code:'42883' へ正規化するのは、検知ロジックを src/lib/db/errors.ts
 * に一元化し、将来判定方法が変わっても正規化後の code が '42883' で安定するように
 * するため（gacha.ts と同じ判断）。呼び出し側の既存 42883 分岐はそのまま
 * 本番実績のある postgrest フォールバックへ流れる。
 *
 * リトライ: 対象 RPC はすべて読み取り専用のため冪等としてリトライを opt-in する。
 * 既存 postgrest 経路のうち get_user_card_counts 系の呼び出しは withRetry を
 * 使っており、リトライ回数・バックオフの既定値（[100,300,1000]ms・最大3回）が
 * 同じため特性が揃う。それ以外の RPC・クエリの postgrest 版はリトライ無しだが、
 * pg 直結はリクエストスコープ接続の破棄（cross-request I/O エラー）からの回復に
 * リトライが必要なため、pg 側は意図的に一律 withDbRetry を付けている
 * （対象が読み取り・冪等のため安全）。
 * 規約: getDb() は queryFn の中で呼ぶ（リクエストスコープ破棄からの回復には
 * クライアント再取得が必要。src/lib/db/retry.ts 参照）。
 */
async function executeDashboardRpcPg<T>(
  context: string,
  runQuery: (sql: DbHandle["sql"]) => Promise<T>,
): Promise<{ data: T | null; error: DashboardRpcDriverError | null }> {
  try {
    const data = await withDbRetry(
      async () => {
        const { sql } = await getDb();
        return runQuery(sql);
      },
      context,
      { idempotent: true },
    );
    return { data, error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (isPgFunctionNotFoundError(error)) {
      return { data: null, error: { code: "42883", message } };
    }

    // その他のエラー(接続断・SQLSTATE 各種・非 Error throw)は code をそのまま
    // 透過し、呼び出し側の既存分岐で PostgREST エラーと同じ外部挙動になる。
    const code = (error as { code?: unknown } | null)?.code;
    return {
      data: null,
      error: { code: typeof code === "string" ? code : undefined, message },
    };
  }
}

/**
 * RPC get_user_card_counts の結果を CardWithDetails[] に変換する
 * RPCはDB側でGROUP BY集計済みのため、JS側での集計は不要
 * to_jsonb経由のDECIMAL→文字列変換に備えてnormalizeDropRateを適用
 */
function parseRpcCardCounts(rpcResult: unknown): CardWithDetails[] {
  const rows = rpcResult as Array<{ count: number; card: Card; streamer: Streamer }>;
  if (!Array.isArray(rows)) return [];
  return normalizeDropRate(rows.map(row => ({
    ...row.card,
    streamer: row.streamer,
    count: row.count,
  })));
}

/**
 * Internal function to fetch user cards from database
 * RPC get_user_card_counts でDB側集計を行い、PostgREST行数制限を根本的に回避する
 * RPC未デプロイ時は直接クエリにフォールバック
 *
 * 内部関数: データベースからユーザーカードを取得
 */
async function fetchUserCardsFromDB(twitchUserId: string): Promise<CardWithDetails[]> {
  const startTotal = Date.now();

  const startClient = Date.now();
  const supabaseAdmin = getSupabaseAdmin();
  logger.info(`[Perf] getSupabaseAdmin: ${Date.now() - startClient}ms`);

  // RPC: DB側でGROUP BY集計（ユニークカード種類数のみ返却、行数制限の影響なし）
  const startQuery = Date.now();
  // #573: DB_DRIVER=pg-read/pg のときのみ RPC 実行を pg 直結へ切り替える。
  // pg 側は PostgREST .rpc() と同一の { data, error } 形状へ正規化して返すため、
  // この直後の成功時パース（parseRpcCardCounts）・42883 分岐（→ 既存 postgrest
  // 直接クエリフォールバック）・その他エラー分岐（reportError + 同フォールバック）は
  // 両経路で完全に共有される。42883/実行時エラー時のフォールバックを postgrest の
  // まま残すのは gacha.ts getIssuedCounts と同じ判断: 異常時の最後の安全弁は
  // 本番実績のある既存経路へ逃がし、直接クエリ集計ロジックの pg 複製
  // （恒久的な重複コード）を避ける。
  // 引数リストは既存 .rpc() 呼び出しと同一（p_twitch_user_id のみ。p_streamer_id は
  // DEFAULT NULL に任せる）。text 引数は名前付き引数の関数解決で一意に強制される
  // ためキャスト不要（gacha.ts executeGachaTransactionRpcPg の doc コメント参照）。
  const { data: rpcResult, error: rpcError } = isPgReadEnabled()
    ? await executeDashboardRpcPg("get_user_card_counts(pg)", async (sql) => {
        // migration 00031: RETURNS JSONB（{ count, card, streamer } オブジェクトの
        // 配列）。PostgREST .rpc() の data と同じ「行配列」がそのまま得られる。
        const rows = await sql<{ result: unknown }[]>`
          select get_user_card_counts(
            p_twitch_user_id => ${twitchUserId}
          ) as result
        `;
        return rows[0]?.result ?? null;
      })
    : await withRetry(
        () => supabaseAdmin.rpc("get_user_card_counts", { p_twitch_user_id: twitchUserId }),
        "get_user_card_counts",
      );

  if (!rpcError) {
    logger.info(`[Perf] getUserCards RPC: ${Date.now() - startQuery}ms`);
    const cards = parseRpcCardCounts(rpcResult);
    logger.info(`[Perf] getUserCards total: ${Date.now() - startTotal}ms`);
    return cards;
  }

  // RPCエラー時は直接クエリにフォールバック（DB一時障害でもカード空表示を防ぐ）
  // TODO: マイグレーション適用確認後にフォールバックを削除
  if (rpcError.code === "42883") {
    logger.warn("get_user_card_counts not deployed, falling back to direct query");
  } else {
    reportError(new Error(`get_user_card_counts RPC failed: ${rpcError.message}`));
  }

  const { data: user } = await supabaseAdmin
    .from("users")
    .select("id")
    .eq("twitch_user_id", twitchUserId)
    .maybeSingle();

  if (!user) {
    logger.info(`[Perf] getUserCards total (no user): ${Date.now() - startTotal}ms`);
    return [];
  }

  // streamers の埋め込みは FK 制約名で一意化する（getStreamerData と同じ理由:
  // migration 00051 の card_owner_stats が cards↔streamers を m2m にも見せるため、
  // ヒントなしの streamers(*) は PGRST201 で失敗する）。
  const { data: userCards } = await supabaseAdmin
    .from("user_cards")
    .select("card_id, cards(*, streamers!cards_streamer_id_fkey(*))")
    .eq("user_id", user.id)
    .range(0, 9999);
  logger.info(`[Perf] getUserCards query: ${Date.now() - startQuery}ms`);

  if (!userCards || userCards.length === 0) {
    logger.info(`[Perf] getUserCards total (no data): ${Date.now() - startTotal}ms`);
    return [];
  }

  if (userCards.length === 10000) {
    reportError(new Error(`user_cards hit 10000 row limit for user ${twitchUserId}`));
  }

  const cardMap = new Map<string, CardWithDetails>();

  for (const uc of userCards) {
    const card = uc.cards as unknown as Card & { streamers: Streamer };
    if (!card) continue;

    const existing = cardMap.get(card.id);
    if (existing) {
      existing.count++;
    } else {
      cardMap.set(card.id, {
        ...card,
        streamer: card.streamers,
        count: 1,
      });
    }
  }

  logger.info(`[Perf] getUserCards total: ${Date.now() - startTotal}ms`);
  return Array.from(cardMap.values());
}

/**
 * Get user's card collection - cached with Next.js cache (30 seconds TTL)
 * Uses unstable_cache for cross-request caching to reduce database load
 *
 * ユーザーのカードコレクション取得 - Next.jsキャッシュ使用（30秒TTL）
 * unstable_cacheでリクエスト間キャッシュを使用してデータベース負荷を軽減
 */
export const getUserCards = cache(async (twitchUserId: string): Promise<CardWithDetails[]> => {
  const start = Date.now();

  // Use Next.js cache with 30 second revalidation
  // Next.jsキャッシュを使用（30秒で再検証）
  const cachedFetch = unstable_cache(
    async () => fetchUserCardsFromDB(twitchUserId),
    [`user-cards-${twitchUserId}`],
    { revalidate: 30, tags: [`user-cards-${twitchUserId}`] }
  );

  const result = await cachedFetch();
  logger.info(`[Perf] getUserCards (with cache): ${Date.now() - start}ms`);
  return result;
})

/**
 * getRecentGachaHistory の Drizzle（pg 直結）実装 (#571)
 *
 * PostgREST の `*, cards(*)` 埋め込みは、gacha_history.card_id → cards.id の
 * 多対一 FK に基づき「単一オブジェクト（マッチなしなら null）」を cards キーに
 * ネストする。pg 版は LEFT JOIN + ネスト選択（cards: cardsTable）で同じ形状を
 * 直接得る（Drizzle は LEFT JOIN でマッチしなかったネストオブジェクトを null に
 * する。card_id は NOT NULL FK のため実データでは常にオブジェクト）。
 * エラー時は既存実装（分割代入で握り潰し → []）と同じ外部挙動。
 */
// Issue #685: cards: cardsTable のネスト select は cards の本番未デプロイ8列を
// 要求する。列欠落エラーなら CARDS_SAFE_COLUMNS へ差し替えて再試行する。
async function selectRecentGachaHistory(useSafeColumns: boolean) {
  return withDbRetry(
    async () => {
      const { db } = await getDb();
      return db
        .select({
          ...getTableColumns(gachaHistoryTable),
          cards: useSafeColumns ? CARDS_SAFE_COLUMNS : cardsTable,
        })
        .from(gachaHistoryTable)
        .leftJoin(cardsTable, eq(gachaHistoryTable.card_id, cardsTable.id))
        .orderBy(desc(gachaHistoryTable.redeemed_at))
        .limit(10);
    },
    "getRecentGachaHistory",
    { idempotent: true },
  );
}

async function getRecentGachaHistoryPg(): Promise<GachaHistoryWithCard[]> {
  try {
    const rows = await withCardsBattleColumnFallback(selectRecentGachaHistory);
    // 既存実装と同じく戻り値型へのキャストのみ（値の変換はしない）
    return rows as unknown as GachaHistoryWithCard[];
  } catch (error) {
    logger.error("Error in getRecentGachaHistory (pg)", { error });
    return [];
  }
}

export async function getRecentGachaHistory(): Promise<GachaHistoryWithCard[]> {
  // #571: pg 直結経路（フラグ未設定時は素通り。getStreamerDataPg 参照）
  if (isPgReadEnabled()) {
    return getRecentGachaHistoryPg();
  }

  const supabaseAdmin = getSupabaseAdmin();

  const { data: history } = await supabaseAdmin
    .from("gacha_history")
    .select(`
      *,
      cards (*)
    `)
    .order("redeemed_at", { ascending: false })
    .limit(10);

  return (history || []) as unknown as GachaHistoryWithCard[];
}

/**
 * Gacha history filter options for streamer queries
 * 配信者向けガチャ履歴フィルタオプション
 */
interface GachaHistoryFilters {
  page?: number;
  perPage?: number;
  username?: string;
  rarity?: string;
  cardId?: string;
  userId?: string;
  from?: string;
  to?: string;
}

/**
 * Paginated gacha history result
 * ページネーション付きガチャ履歴結果
 */
interface PaginatedGachaHistory {
  history: GachaHistoryWithCard[];
  pagination: {
    page: number;
    perPage: number;
    total: number;
    totalPages: number;
  };
}

/**
 * getGachaHistoryForStreamer の Drizzle（pg 直結）実装 (#571)
 *
 * PostgREST 実装との対応:
 * - `*, cards(*)` / `cards!inner(*)` の埋め込み → LEFT JOIN + ネスト選択。
 *   rarity フィルタ時に PostgREST が !inner を使うのは「埋め込みフィルタで
 *   トップレベル行も絞り込む」ためだが、SQL では LEFT JOIN + WHERE
 *   cards.rarity = X が INNER JOIN + 同条件と完全に等価（NULL 拡張行は WHERE で
 *   落ちる）なので、JOIN 種別を分岐せず常に LEFT JOIN + WHERE で両ケースを表現
 *   できる。rarity フィルタなしの場合も card_id は NOT NULL FK（cards.id への
 *   参照）のため LEFT JOIN は行数を増減させず、!inner の有無による差は出ない。
 * - `{ count: "exact" }` はフィルタ適用後のトップレベル行数 → 同じ WHERE の
 *   COUNT(*) クエリ。上記と同じ理由で JOIN しても行数は変わらないため、rarity
 *   条件が cards 列を参照できるよう count クエリにも同じ LEFT JOIN を張る。
 * - `.ilike()` の LIKE パターン（% と _ を \ でエスケープ）はバインド値として
 *   そのまま PostgreSQL に渡り、既定のエスケープ文字も \ なので意味論は同一。
 * - `.range(offset, offset + perPage - 1)` = LIMIT perPage OFFSET offset。
 * - エラー時: 既存実装は分割代入で握り潰し data=null / count=null →
 *   { history: [], total: 0, totalPages: 0 }。単一リクエスト失敗で両方 null に
 *   なる挙動に合わせ、pg 版も rows/count のどちらが失敗しても同じ空結果を返す。
 */
async function getGachaHistoryForStreamerPg(
  streamerId: string,
  filters: GachaHistoryFilters
): Promise<PaginatedGachaHistory> {
  const { page = 1, perPage = 20, username, rarity, cardId, userId, from, to } = filters;

  // WHERE 条件は PostgREST 版のフィルタと1対1対応で組み立てる
  const conditions = [eq(gachaHistoryTable.streamer_id, streamerId)];
  if (username) {
    // Escape LIKE pattern characters to prevent unintended matching
    // LIKEパターン文字をエスケープして意図しないマッチを防止（既存実装と同一）
    const escaped = username.replace(/%/g, "\\%").replace(/_/g, "\\_");
    conditions.push(ilike(gachaHistoryTable.user_twitch_username, `%${escaped}%`));
  }
  if (rarity) {
    conditions.push(eq(cardsTable.rarity, rarity));
  }
  if (cardId) {
    conditions.push(eq(gachaHistoryTable.card_id, cardId));
  }
  if (userId) {
    conditions.push(eq(gachaHistoryTable.user_twitch_id, userId));
  }
  if (from) {
    conditions.push(gte(gachaHistoryTable.redeemed_at, from));
  }
  if (to) {
    // 「次の日未満」で "to" 日付全体を含める（既存実装と同一のUTC解釈）
    const nextDay = new Date(`${to}T00:00:00Z`);
    nextDay.setUTCDate(nextDay.getUTCDate() + 1);
    conditions.push(lt(gachaHistoryTable.redeemed_at, nextDay.toISOString()));
  }
  const whereClause = and(...conditions);
  const offset = (page - 1) * perPage;

  // Issue #685: cards: cardsTable のネスト select は cards の本番未デプロイ8列を
  // 要求する。count クエリは cards の列を選択しない（leftJoin は行数維持のみ）ため
  // 対象外。列欠落エラーなら CARDS_SAFE_COLUMNS へ差し替えて再試行する。
  async function selectRows(useSafeColumns: boolean) {
    return withDbRetry(
      async () => {
        const { db } = await getDb();
        return db
          .select({
            ...getTableColumns(gachaHistoryTable),
            cards: useSafeColumns ? CARDS_SAFE_COLUMNS : cardsTable,
          })
          .from(gachaHistoryTable)
          .leftJoin(cardsTable, eq(gachaHistoryTable.card_id, cardsTable.id))
          .where(whereClause)
          .orderBy(desc(gachaHistoryTable.redeemed_at))
          .limit(perPage)
          .offset(offset);
      },
      "getGachaHistoryForStreamer(rows)",
      { idempotent: true },
    );
  }
  try {
    const [rows, total] = await Promise.all([
      withCardsBattleColumnFallback(selectRows),
      withDbRetry(
        async () => {
          const { db } = await getDb();
          const result = await db
            .select({ count: countRows() })
            .from(gachaHistoryTable)
            .leftJoin(cardsTable, eq(gachaHistoryTable.card_id, cardsTable.id))
            .where(whereClause);
          return result[0]?.count ?? 0;
        },
        "getGachaHistoryForStreamer(count)",
        { idempotent: true },
      ),
    ]);

    return {
      history: rows as unknown as GachaHistoryWithCard[],
      pagination: {
        page,
        perPage,
        total,
        totalPages: Math.ceil(total / perPage),
      },
    };
  } catch (error) {
    logger.error("Error in getGachaHistoryForStreamer (pg)", { error });
    return {
      history: [],
      pagination: { page, perPage, total: 0, totalPages: 0 },
    };
  }
}

/**
 * Get gacha history for a streamer with pagination and filters
 * Supports filtering by username, rarity, and date range
 * 配信者向け: ページネーション・フィルタ付きガチャ履歴取得
 * ユーザー名、レアリティ、期間でのフィルタリングをサポート
 */
export async function getGachaHistoryForStreamer(
  streamerId: string,
  filters: GachaHistoryFilters = {}
): Promise<PaginatedGachaHistory> {
  // #571: pg 直結経路（フラグ未設定時は素通り。getStreamerDataPg 参照）
  if (isPgReadEnabled()) {
    return getGachaHistoryForStreamerPg(streamerId, filters);
  }

  const { page = 1, perPage = 20, username, rarity, cardId, userId, from, to } = filters;
  const supabaseAdmin = getSupabaseAdmin();

  // Use !inner join when filtering by rarity to ensure correct count
  // レアリティフィルタ時は !inner JOINで正確なcountを保証
  const joinType = rarity ? "cards!inner(*)" : "cards(*)";
  let query = supabaseAdmin
    .from("gacha_history")
    .select(`*, ${joinType}`, { count: "exact" })
    .eq("streamer_id", streamerId);

  // Apply filters / フィルタを適用
  if (username) {
    // Escape LIKE pattern characters to prevent unintended matching
    // LIKEパターン文字をエスケープして意図しないマッチを防止
    const escaped = username.replace(/%/g, "\\%").replace(/_/g, "\\_");
    query = query.ilike("user_twitch_username", `%${escaped}%`);
  }
  if (rarity) {
    query = query.eq("cards.rarity", rarity);
  }
  if (cardId) {
    query = query.eq("card_id", cardId);
  }
  if (userId) {
    query = query.eq("user_twitch_id", userId);
  }
  if (from) {
    query = query.gte("redeemed_at", from);
  }
  if (to) {
    // Use "less than next day" instead of "less than or equal to end-of-day"
    // to cleanly include the entire "to" date
    // Note: dates are interpreted in UTC. For non-UTC users, boundary dates
    // may shift by a few hours. This is acceptable for approximate date filtering.
    // 「次の日未満」を使用して "to" 日付全体を含める
    // 注: 日付はUTCで解釈される。非UTCユーザーでは境界日が数時間ずれる可能性があるが、
    // 大まかな日付フィルタとしては許容範囲。
    const nextDay = new Date(`${to}T00:00:00Z`);
    nextDay.setUTCDate(nextDay.getUTCDate() + 1);
    query = query.lt("redeemed_at", nextDay.toISOString());
  }

  // Apply pagination and ordering
  // ページネーションと並び順を適用
  const offset = (page - 1) * perPage;
  query = query
    .order("redeemed_at", { ascending: false })
    .range(offset, offset + perPage - 1);

  const { data, count } = await query;
  const total = count || 0;

  return {
    history: (data || []) as unknown as GachaHistoryWithCard[],
    pagination: {
      page,
      perPage,
      total,
      totalPages: Math.ceil(total / perPage),
    },
  };
}

/**
 * getGachaHistoryForUser の Drizzle（pg 直結）実装 (#571)
 *
 * PostgREST の `*, cards(*), streamers(twitch_display_name)` は、いずれも
 * 多対一 FK（card_id → cards.id / streamer_id → streamers.id）に基づく
 * 「単一オブジェクト」埋め込み。pg 版は 2 つの LEFT JOIN + ネスト選択で
 * 同じ形状を得る。streamers は twitch_display_name の 1 列だけを選択した
 * ネストオブジェクト（{ twitch_display_name } | null）にし、列を絞った埋め込み
 * の形状（GachaHistoryTable が entry.streamers.twitch_display_name として消費）
 * を厳密に再現する。count は WHERE のみで決まる（JOIN は多対一で行数不変）ため
 * gacha_history 単独の COUNT(*) で等価。
 * エラー時は getGachaHistoryForStreamerPg と同じく空結果（既存挙動どおり）。
 */
async function getGachaHistoryForUserPg(
  userTwitchId: string,
  filters: { page?: number; perPage?: number }
): Promise<PaginatedGachaHistory> {
  const { page = 1, perPage = 20 } = filters;
  const offset = (page - 1) * perPage;

  // Issue #685: cards: cardsTable のネスト select は cards の本番未デプロイ8列を
  // 要求する。count クエリは cards を選択しない（JOINすら行わない）ため対象外。
  // 列欠落エラーなら CARDS_SAFE_COLUMNS へ差し替えて再試行する。
  async function selectRows(useSafeColumns: boolean) {
    return withDbRetry(
      async () => {
        const { db } = await getDb();
        return db
          .select({
            ...getTableColumns(gachaHistoryTable),
            cards: useSafeColumns ? CARDS_SAFE_COLUMNS : cardsTable,
            streamers: { twitch_display_name: streamersTable.twitch_display_name },
          })
          .from(gachaHistoryTable)
          .leftJoin(cardsTable, eq(gachaHistoryTable.card_id, cardsTable.id))
          .leftJoin(streamersTable, eq(gachaHistoryTable.streamer_id, streamersTable.id))
          .where(eq(gachaHistoryTable.user_twitch_id, userTwitchId))
          .orderBy(desc(gachaHistoryTable.redeemed_at))
          .limit(perPage)
          .offset(offset);
      },
      "getGachaHistoryForUser(rows)",
      { idempotent: true },
    );
  }
  try {
    const [rows, total] = await Promise.all([
      withCardsBattleColumnFallback(selectRows),
      withDbRetry(
        async () => {
          const { db } = await getDb();
          const result = await db
            .select({ count: countRows() })
            .from(gachaHistoryTable)
            .where(eq(gachaHistoryTable.user_twitch_id, userTwitchId));
          return result[0]?.count ?? 0;
        },
        "getGachaHistoryForUser(count)",
        { idempotent: true },
      ),
    ]);

    return {
      history: rows as unknown as GachaHistoryWithCard[],
      pagination: {
        page,
        perPage,
        total,
        totalPages: Math.ceil(total / perPage),
      },
    };
  } catch (error) {
    logger.error("Error in getGachaHistoryForUser (pg)", { error });
    return {
      history: [],
      pagination: { page, perPage, total: 0, totalPages: 0 },
    };
  }
}

/**
 * Get gacha history for a specific user with pagination
 * 視聴者向け: ページネーション付きの自分のガチャ履歴取得
 */
export async function getGachaHistoryForUser(
  userTwitchId: string,
  filters: { page?: number; perPage?: number } = {}
): Promise<PaginatedGachaHistory> {
  // #571: pg 直結経路（フラグ未設定時は素通り。getStreamerDataPg 参照）
  if (isPgReadEnabled()) {
    return getGachaHistoryForUserPg(userTwitchId, filters);
  }

  const { page = 1, perPage = 20 } = filters;
  const supabaseAdmin = getSupabaseAdmin();

  const offset = (page - 1) * perPage;
  // Join streamers to show which channel the gacha was drawn on
  // どのチャネルでガチャを引いたかを表示するため streamers を JOIN
  const { data, count } = await supabaseAdmin
    .from("gacha_history")
    .select("*, cards(*), streamers(twitch_display_name)", { count: "exact" })
    .eq("user_twitch_id", userTwitchId)
    .order("redeemed_at", { ascending: false })
    .range(offset, offset + perPage - 1);

  const total = count || 0;

  return {
    history: (data || []) as unknown as GachaHistoryWithCard[],
    pagination: {
      page,
      perPage,
      total,
      totalPages: Math.ceil(total / perPage),
    },
  };
}

/**
 * Gacha user entry for the users tab
 * ユーザータブ用のガチャユーザー情報
 */
export interface GachaUserEntry {
  userTwitchId: string;
  username: string;
  drawCount: number;
  uniqueCards: number;
  /** Active cards the user has drawn at least once (unique by card ID) */
  uniqueCardIds: string[];
  lastDrawAt: string;
}

function normalizeUniqueCardIds(cardIds: unknown): string[] {
  if (!Array.isArray(cardIds)) {
    return [];
  }

  return Array.from(
    new Set(
      cardIds.filter(
        (cardId): cardId is string =>
          typeof cardId === "string" && cardId.length > 0
      )
    )
  );
}

/**
 * getGachaUsersForStreamer のフォールバック集約用クエリの Drizzle（pg 直結）実装 (#573)。
 *
 * ユーザータブは RPC 失敗時にもクライアント側集約で必ず表示を維持する設計のため
 * （握り潰すと配信者に「ユーザーなし」と誤表示される）、pg 経路でも同じ
 * フォールバックを pg で再現する。他の統計系 RPC（getGachaStats 等）が
 * フォールバック集計を postgrest のまま共有するのと異なり、この関数の
 * フォールバックは gacha_history / cards の単純な2クエリ + 共有可能な JS 集約で
 * 構成されており、クエリ部分だけの差し替えで済む（集約ロジックは呼び出し側で
 * 両経路共有のまま）。
 *
 * PostgREST 実装との対応:
 * - gacha_history: select("user_twitch_id, user_twitch_username, card_id, redeemed_at")
 *   + streamer_id filter + redeemed_at 降順を列指定 select で再現。行数は既存経路の
 *   .limit(10000) が Supabase 既定の max-rows=1000 で実効 1000 行にキャップされる
 *   ため、pg 経路は明示 LIMIT 1000 で現行本番の実効挙動に合わせる（下の
 *   コメント参照）。
 * - cards: select("id") + streamer_id / is_active filter。既存経路は limit 無指定の
 *   ため PostgREST max-rows=1000 でトップレベル行が暗黙に打ち切られる。pg 経路だけ
 *   件数が変わらないよう明示 LIMIT 1000 を付ける（#571 の
 *   fetchActiveCardsForStreamerFromDBPg と同じ挙動パリティ優先の方針）。
 * - 戻り値は PostgREST の { data, error } 形状にクエリ単位で正規化する。片方の
 *   失敗がもう片方を巻き込まない点（分割代入で独立に消費される）も既存と同じ。
 *
 * 日付は pg 直結だと src/lib/db/client.ts の installIsoTimestampParsers() により
 * ISO 8601 に正規化される（#688。正規化前は PG テキスト形式だった）ため、消費側
 * （lastDrawAt の文字列比較・表示）への影響は #571 の他関数と同じ扱い。
 */
async function fetchGachaUsersFallbackRowsPg(streamerId: string): Promise<
  [
    {
      data: Array<{
        user_twitch_id: string;
        user_twitch_username: string | null;
        card_id: string;
        redeemed_at: string;
      }> | null;
      error: { message: string } | null;
    },
    { data: Array<{ id: string }> | null; error: { message: string } | null },
  ]
> {
  return Promise.all([
    (async () => {
      try {
        const rows = await withDbRetry(
          async () => {
            const { db } = await getDb();
            return db
              .select({
                user_twitch_id: gachaHistoryTable.user_twitch_id,
                user_twitch_username: gachaHistoryTable.user_twitch_username,
                card_id: gachaHistoryTable.card_id,
                redeemed_at: gachaHistoryTable.redeemed_at,
              })
              .from(gachaHistoryTable)
              .where(eq(gachaHistoryTable.streamer_id, streamerId))
              .orderBy(desc(gachaHistoryTable.redeemed_at))
              // 既存 postgrest 経路の .limit(10000) は Supabase 既定の
              // max-rows=1000 で実効 1000 行にキャップされるため、pg 直結も
              // それに合わせて LIMIT 1000 とする（現行本番の実効挙動との
              // パリティ）。max-rows 設定を既定から変更している場合はこの値も
              // 合わせること（docs/db-driver-migration.md の preview 検証項目参照）。
              .limit(1000);
          },
          "getGachaUsersForStreamer(fallback:history)",
          { idempotent: true },
        );
        // redeemed_at は Drizzle スキーマ上 nullable だが実データは DEFAULT now() で
        // 常に非 null。既存 supabase 生成型（string）に合わせるキャストのみ行う
        // （値の変換はしない。#571 の他 xxxPg と同じ方針）。
        return {
          data: rows as unknown as Array<{
            user_twitch_id: string;
            user_twitch_username: string | null;
            card_id: string;
            redeemed_at: string;
          }>,
          error: null,
        };
      } catch (error) {
        return {
          data: null,
          error: { message: error instanceof Error ? error.message : String(error) },
        };
      }
    })(),
    (async () => {
      try {
        const rows = await withDbRetry(
          async () => {
            const { db } = await getDb();
            return db
              .select({ id: cardsTable.id })
              .from(cardsTable)
              .where(and(eq(cardsTable.streamer_id, streamerId), eq(cardsTable.is_active, true)))
              .limit(1000);
          },
          "getGachaUsersForStreamer(fallback:activeCards)",
          { idempotent: true },
        );
        return { data: rows, error: null };
      } catch (error) {
        // 既存経路は activeCardsResult.error を参照しない（data null → 空 Set 扱い）。
        // 同じ外部挙動になるよう data: null に落とすだけにする。
        return {
          data: null,
          error: { message: error instanceof Error ? error.message : String(error) },
        };
      }
    })(),
  ]);
}

/**
 * Get aggregated user list for a streamer's gacha history
 * RPC get_gacha_users_for_streamer でDB側集計を行い、件数制限なしで正確なカード所有状況を返す
 * RPC未デプロイ時はクライアント側集約にフォールバック（10,000件制限付き）
 * 配信者向け: ガチャを引いたユーザー一覧を集約して返す
 */
export async function getGachaUsersForStreamer(
  streamerId: string,
  options: { page?: number; perPage?: number } = {}
): Promise<{ users: GachaUserEntry[]; pagination: { page: number; perPage: number; total: number; totalPages: number } }> {
  const { page = 1, perPage = 20 } = options;
  const supabaseAdmin = getSupabaseAdmin();
  const offset = (page - 1) * perPage;

  // RPC: DB側でGROUP BY集約 + ページネーション（件数制限なし）
  // #573: pg 直結分岐は「RPC を実行して { data, error } を得る」1箇所だけ
  // （executeDashboardRpcPg の doc コメント参照）。成功時のパース・エラー時の
  // ログ分岐（42883 → warn / その他 → reportError）は両経路で共有され、
  // フォールバック集約のクエリ実行だけが下でもう1箇所分岐する。
  // uuid / integer 引数は明示キャストで型解決を固定する（gacha.ts と同じ規約）。
  const { data: rpcResult, error: rpcError } = isPgReadEnabled()
    ? await executeDashboardRpcPg("get_gacha_users_for_streamer(pg)", async (sql) => {
        // migration 00032/00046: RETURNS JSONB ({ users: [...], total: n })。
        // PostgREST .rpc() の data と同じオブジェクトがそのまま得られる。
        const rows = await sql<{ result: unknown }[]>`
          select get_gacha_users_for_streamer(
            p_streamer_id => ${streamerId}::uuid,
            p_limit => ${perPage}::integer,
            p_offset => ${offset}::integer
          ) as result
        `;
        return rows[0]?.result ?? null;
      })
    : await supabaseAdmin
        .rpc("get_gacha_users_for_streamer", {
          p_streamer_id: streamerId,
          p_limit: perPage,
          p_offset: offset,
        });

  if (!rpcError && rpcResult) {
    // RPC成功: DB側集約結果をGachaUserEntry[]に変換
    // asキャストだが、SQL側でCOALESCEにより users/unique_card_ids は必ず配列を返す
    const rpcData = rpcResult as { users: Array<{ user_twitch_id: string; username: string; draw_count: number; last_draw_at: string; unique_card_ids: string[] }>; total: number };
    const rpcUsers = rpcData.users || [];
    const users: GachaUserEntry[] = rpcUsers.map((u) => {
      const uniqueCardIds = normalizeUniqueCardIds(u.unique_card_ids);
      return {
        userTwitchId: u.user_twitch_id,
        username: u.username || "",
        drawCount: u.draw_count,
        uniqueCards: uniqueCardIds.length,
        uniqueCardIds,
        lastDrawAt: u.last_draw_at,
      };
    });
    const total = rpcData.total || 0;
    return {
      users,
      pagination: { page, perPage, total, totalPages: Math.ceil(total / perPage) },
    };
  }

  // RPCエラー時はクライアント側集約にフォールバック（マイグレーション未適用時の互換性維持）
  // TODO: マイグレーション適用確認後にフォールバックを削除
  if (rpcError?.code === "42883") {
    logger.warn("get_gacha_users_for_streamer not deployed, falling back to client-side aggregation");
  } else if (rpcError) {
    reportError(new Error(`get_gacha_users_for_streamer RPC failed: ${rpcError.message}`));
  }

  // フォールバック: 既存のクライアント側集約ロジック（10,000件制限あり）
  // #573: pg 経路では同じフォールバッククエリを pg で再現する
  // （fetchGachaUsersFallbackRowsPg の doc コメント参照）。クエリ結果は
  // { data, error } 形状で正規化されるため、以降の集約・ページング処理は
  // 両経路で完全に共有される。
  const [historyResult, activeCardsResult] = isPgReadEnabled()
    ? await fetchGachaUsersFallbackRowsPg(streamerId)
    : await Promise.all([
        supabaseAdmin
          .from("gacha_history")
          .select("user_twitch_id, user_twitch_username, card_id, redeemed_at")
          .eq("streamer_id", streamerId)
          .order("redeemed_at", { ascending: false })
          .limit(10000),
        supabaseAdmin
          .from("cards")
          .select("id")
          .eq("streamer_id", streamerId)
          .eq("is_active", true),
      ]);

  // フォールバックDBエラー時はreportErrorで検知可能にする
  if (historyResult.error) {
    reportError(new Error(`gacha_history fallback query failed: ${historyResult.error.message}`));
  }

  const data = historyResult.data;
  if (!data || data.length === 0) {
    return {
      users: [],
      pagination: { page, perPage, total: 0, totalPages: 0 },
    };
  }

  const activeCardIds = new Set((activeCardsResult.data || []).map((c) => c.id));

  // ユーザーごとに集約
  const userMap = new Map<string, {
    username: string;
    drawCount: number;
    cardIds: Set<string>;
    lastDrawAt: string;
  }>();

  for (const row of data) {
    const existing = userMap.get(row.user_twitch_id);
    if (existing) {
      existing.drawCount++;
      if (activeCardIds.has(row.card_id)) {
        existing.cardIds.add(row.card_id);
      }
    } else {
      const cardIds = new Set<string>();
      if (activeCardIds.has(row.card_id)) {
        cardIds.add(row.card_id);
      }
      userMap.set(row.user_twitch_id, {
        username: row.user_twitch_username || "",
        drawCount: 1,
        cardIds,
        lastDrawAt: row.redeemed_at,
      });
    }
  }

  const allUsers: GachaUserEntry[] = Array.from(userMap.entries())
    .map(([userTwitchId, info]) => ({
      userTwitchId,
      username: info.username,
      drawCount: info.drawCount,
      uniqueCards: info.cardIds.size,
      uniqueCardIds: Array.from(info.cardIds),
      lastDrawAt: info.lastDrawAt,
    }))
    .sort((a, b) => b.drawCount - a.drawCount);

  const total = allUsers.length;
  const fallbackOffset = (page - 1) * perPage;
  const paginatedUsers = allUsers.slice(fallbackOffset, fallbackOffset + perPage);

  return {
    users: paginatedUsers,
    pagination: {
      page,
      perPage,
      total,
      totalPages: Math.ceil(total / perPage),
    },
  };
}

/**
 * Gacha statistics result for a streamer
 * 配信者向けガチャ統計結果
 */
export interface GachaStatsResult {
  totalDraws: number;
  channelPointStats: {
    totalPoints: number;
    ranking: Array<{
      userTwitchId: string;
      username: string;
      totalPoints: number;
      redemptionCount: number;
      lastRedeemedAt: string | null;
    }>;
  };
  cardStats: Array<{
    cardId: string;
    cardName: string;
    rarity: string;
    imageUrl: string | null;
    configuredRate: number;
    actualCount: number;
    actualRate: number;
    // 期間内にそのカードを引いたユニークユーザー数とその一覧
    // (所持ユーザーではなく、当該期間の排出履歴ベース)
    drawerCount: number;
    drawers: Array<{
      userTwitchId: string;
      username: string;
      drawCount: number;
      lastDrawnAt: string;
    }>;
  }>;
  rarityStats: Array<{
    rarity: string;
    count: number;
    rate: number;
  }>;
}

/**
 * Per-card all-time owner statistics for the "by card" tab.
 * 「カード別」タブ用: 全期間のカード別所持ユーザー統計
 */
export interface GachaCardOwnerStatsResult {
  cardStats: Array<{
    cardId: string;
    cardName: string;
    rarity: string;
    imageUrl: string | null;
    ownerCount: number;
    owners: Array<{
      userTwitchId: string;
      username: string;
      displayName: string;
      ownedCount: number;
      lastObtainedAt: string;
    }>;
  }>;
}

interface ChannelPointUsageStatsRpcRow {
  user_twitch_id: string;
  username: string | null;
  total_points: number | string;
  redemption_count: number;
  last_redeemed_at: string | null;
}

interface ChannelPointUsageHistoryRow {
  user_twitch_id: string;
  user_twitch_username: string | null;
  reward_cost: number | string | null;
  redeemed_at: string | null;
}

interface GachaDropStatsRpcDrawerRow {
  user_twitch_id: string;
  username: string | null;
  draw_count: number | string;
  last_drawn_at: string | null;
}

interface GachaDropStatsRpcCardRow {
  card_id: string;
  card_name: string;
  rarity: string;
  image_url: string | null;
  configured_rate: number | string;
  actual_count: number | string;
  actual_rate: number | string;
  drawer_count?: number | string | null;
  drawers?: GachaDropStatsRpcDrawerRow[] | null;
}

interface GachaDropStatsRpcRarityRow {
  rarity: string;
  count: number | string;
  rate: number | string;
}

type GachaStatsDrawer = GachaStatsResult["cardStats"][number]["drawers"][number];

type GachaCardOwner =
  GachaCardOwnerStatsResult["cardStats"][number]["owners"][number];

interface CardOwnerStatsRpcOwnerRow {
  user_twitch_id: string;
  username: string | null;
  display_name: string | null;
  owned_count: number | string;
  last_obtained_at: string | null;
}

interface CardOwnerStatsRpcCardRow {
  card_id: string;
  card_name: string;
  rarity: string;
  image_url: string | null;
  owner_count: number | string;
  owners?: CardOwnerStatsRpcOwnerRow[] | null;
}

type GachaCardOwnerStatsOwnerRow = {
  card_id: string;
  obtained_at: string;
  users:
    | {
        twitch_user_id: string;
        twitch_username: string | null;
        twitch_display_name: string | null;
      }
    | Array<{
        twitch_user_id: string;
        twitch_username: string | null;
        twitch_display_name: string | null;
      }>
    | null;
};

// 1カードあたりに返すユーザー（引いた/所持）件数の上限。
// JSONBペイロード肥大を防ぐためRPCと履歴フォールバックで共通化する
// (RPC: get_gacha_drop_stats / get_card_owner_stats の p_limit_per_card 既定値と一致)。
const STATS_USERS_PER_CARD_LIMIT = 100;

function parseGachaDropStatsRpc(rpcResult: unknown): Omit<GachaStatsResult, "channelPointStats"> | null {
  if (!rpcResult || typeof rpcResult !== "object") return null;

  const payload = rpcResult as {
    total_draws?: number | string | null;
    card_stats?: GachaDropStatsRpcCardRow[] | null;
    rarity_stats?: GachaDropStatsRpcRarityRow[] | null;
  };
  if (!Array.isArray(payload.card_stats) || !Array.isArray(payload.rarity_stats)) {
    return null;
  }

  // デプロイ過渡期対策: 旧 get_gacha_drop_stats(2引数, migration 00050)が
  // まだ稼働している場合、payload は有効だが drawers/drawer_count を欠く。
  // この場合に成功扱いすると 7日/30日 タブの「引いたユーザー」が恒久的に
  // 空表示になるため、スキーマが古いとみなして null を返し、呼び出し側で
  // 履歴フォールバック(fetchGachaDropStatsFromHistory)に切り替えさせる。
  // card_stats が空(=カード未登録)の場合は表示対象が無く判別不能なので
  // そのまま空結果として返す（フォールバックも同じく空を返す）。
  if (
    payload.card_stats.length > 0 &&
    !("drawer_count" in payload.card_stats[0])
  ) {
    return null;
  }

  return {
    totalDraws: Number(payload.total_draws || 0),
    cardStats: payload.card_stats.map((row) => ({
      cardId: row.card_id,
      cardName: row.card_name,
      rarity: row.rarity,
      imageUrl: row.image_url,
      configuredRate: Number(row.configured_rate || 0),
      actualCount: Number(row.actual_count || 0),
      actualRate: Number(row.actual_rate || 0),
      drawerCount: Number(row.drawer_count || 0),
      drawers: (Array.isArray(row.drawers) ? row.drawers : []).map((d) => ({
        userTwitchId: d.user_twitch_id,
        username: d.username || d.user_twitch_id,
        drawCount: Number(d.draw_count || 0),
        lastDrawnAt: d.last_drawn_at || "",
      })),
    })),
    rarityStats: payload.rarity_stats.map((row) => ({
      rarity: row.rarity,
      count: Number(row.count || 0),
      rate: Number(row.rate || 0),
    })),
  };
}

function parseChannelPointUsageStatsRpc(rpcResult: unknown): GachaStatsResult["channelPointStats"] | null {
  if (!rpcResult || typeof rpcResult !== "object") return null;

  const payload = rpcResult as {
    total_points?: number | string | null;
    ranking?: ChannelPointUsageStatsRpcRow[] | null;
  };
  if (!Array.isArray(payload.ranking)) return null;

  return {
    totalPoints: Number(payload.total_points || 0),
    ranking: payload.ranking.map((row) => ({
      userTwitchId: row.user_twitch_id,
      username: row.username || row.user_twitch_id,
      totalPoints: Number(row.total_points || 0),
      redemptionCount: row.redemption_count,
      lastRedeemedAt: row.last_redeemed_at,
    })),
  };
}

const EMPTY_CHANNEL_POINT_STATS: GachaStatsResult["channelPointStats"] = {
  totalPoints: 0,
  ranking: [],
};

async function fetchChannelPointUsageStatsFromHistory(
  supabaseAdmin: ReturnType<typeof getSupabaseAdmin>,
  streamerId: string,
  limit = 10
): Promise<GachaStatsResult["channelPointStats"]> {
  const { data, error } = await supabaseAdmin
    .from("gacha_history")
    .select("user_twitch_id, user_twitch_username, reward_cost, redeemed_at")
    .eq("streamer_id", streamerId)
    .gt("reward_cost", 0)
    .order("redeemed_at", { ascending: false })
    .limit(10000);

  if (error) {
    reportError(new Error(`channel point usage fallback query failed: ${error.message}`));
    return EMPTY_CHANNEL_POINT_STATS;
  }

  const usageByUser = new Map<string, {
    username: string;
    totalPoints: number;
    redemptionCount: number;
    lastRedeemedAt: string | null;
  }>();
  let totalPoints = 0;

  for (const row of (data || []) as ChannelPointUsageHistoryRow[]) {
    const rewardCost = Number(row.reward_cost || 0);
    if (!row.user_twitch_id || rewardCost <= 0) continue;

    totalPoints += rewardCost;
    const existing = usageByUser.get(row.user_twitch_id);
    if (existing) {
      existing.totalPoints += rewardCost;
      existing.redemptionCount += 1;
      if (row.user_twitch_username) {
        existing.username = row.user_twitch_username;
      }
      if (
        row.redeemed_at &&
        (!existing.lastRedeemedAt || row.redeemed_at > existing.lastRedeemedAt)
      ) {
        existing.lastRedeemedAt = row.redeemed_at;
      }
    } else {
      usageByUser.set(row.user_twitch_id, {
        username: row.user_twitch_username || row.user_twitch_id,
        totalPoints: rewardCost,
        redemptionCount: 1,
        lastRedeemedAt: row.redeemed_at,
      });
    }
  }

  return {
    totalPoints,
    ranking: Array.from(usageByUser.entries())
      .map(([userTwitchId, usage]) => ({ userTwitchId, ...usage }))
      .sort((a, b) => {
        if (b.totalPoints !== a.totalPoints) return b.totalPoints - a.totalPoints;
        if (b.redemptionCount !== a.redemptionCount) return b.redemptionCount - a.redemptionCount;
        return (b.lastRedeemedAt || "").localeCompare(a.lastRedeemedAt || "");
      })
      .slice(0, Math.max(1, limit)),
  };
}


/**
 * Fallback drop-rate aggregation computed directly from gacha_history + cards.
 *
 * get_gacha_drop_stats（RPC, migration 00038）が本番に未デプロイ、または
 * 実行時エラーで失敗した場合、getGachaStats はフォールバック無しだと
 * totalDraws=0 を返し、配信者には毎日大量にガチャが回っていても
 * 「この期間にはガチャデータがありません。」と誤表示されてしまう。
 * channelPointStats が fetchChannelPointUsageStatsFromHistory で
 * 同様に救済されているのと対称になるよう、ここでも履歴から直接集計する。
 *
 * ロジックは RPC（migration 00038）および analysis/DropRateStats.tsx と
 * 同一: 総数は count-only クエリで正確に取得し、カード別/レアリティ別の
 * 内訳は上限 10000 件の履歴サンプルから集計する（PostgREST の行上限対策）。
 */
async function fetchGachaDropStatsFromHistory(
  supabaseAdmin: ReturnType<typeof getSupabaseAdmin>,
  streamerId: string,
  fromDateIso: string
): Promise<Omit<GachaStatsResult, "channelPointStats">> {
  const FIXED_RARITIES = ["legendary", "epic", "rare", "common"] as const;
  const emptyRarityStats = FIXED_RARITIES.map((rarity) => ({
    rarity,
    count: 0,
    rate: 0,
  }));

  const [countResult, historyResult, cardsResult] = await Promise.all([
    supabaseAdmin
      .from("gacha_history")
      .select("id", { count: "exact", head: true })
      .eq("streamer_id", streamerId)
      .gte("redeemed_at", fromDateIso),
    supabaseAdmin
      .from("gacha_history")
      .select(
        "card_id, user_twitch_id, user_twitch_username, redeemed_at, cards(rarity)"
      )
      .eq("streamer_id", streamerId)
      .gte("redeemed_at", fromDateIso)
      .limit(10000),
    supabaseAdmin
      .from("cards")
      .select("id, name, rarity, image_url, drop_rate, rarity_order, created_at")
      .eq("streamer_id", streamerId)
      .eq("is_active", true)
      .order("rarity_order", { ascending: true })
      .order("created_at", { ascending: false }),
  ]);

  if (countResult.error || historyResult.error || cardsResult.error) {
    reportError(
      new Error(
        `gacha drop stats fallback query failed: ${
          countResult.error?.message ||
          historyResult.error?.message ||
          cardsResult.error?.message
        }`
      )
    );
    return { totalDraws: 0, cardStats: [], rarityStats: emptyRarityStats };
  }

  const totalDraws = countResult.count || 0;
  // Supabase の型推論が select('card_id, cards(rarity)') に対して不完全なため明示キャスト
  const history = (historyResult.data || []) as unknown as Array<{
    card_id: string;
    user_twitch_id: string;
    user_twitch_username: string | null;
    redeemed_at: string | null;
    cards: { rarity: string } | null;
  }>;
  const cards = (cardsResult.data || []) as Array<{
    id: string;
    name: string;
    rarity: string;
    image_url: string | null;
    drop_rate: number | string | null;
    created_at: string;
  }>;

  const drawCounts = new Map<string, number>();
  // 期間内にそのカードを引いたユーザーをカード×ユーザーで集計。
  // RPC(get_gacha_drop_stats)と同じく1カードあたり上限件数で打ち切る。
  const drawersByCard = new Map<string, Map<string, GachaStatsDrawer>>();
  for (const row of history) {
    drawCounts.set(row.card_id, (drawCounts.get(row.card_id) || 0) + 1);

    if (!row.user_twitch_id) continue;
    const cardDrawers = drawersByCard.get(row.card_id) || new Map();
    const existing = cardDrawers.get(row.user_twitch_id);
    if (existing) {
      existing.drawCount += 1;
      if (row.redeemed_at && row.redeemed_at > existing.lastDrawnAt) {
        existing.lastDrawnAt = row.redeemed_at;
      }
      if (row.user_twitch_username) {
        existing.username = row.user_twitch_username;
      }
    } else {
      cardDrawers.set(row.user_twitch_id, {
        userTwitchId: row.user_twitch_id,
        username: row.user_twitch_username || row.user_twitch_id,
        drawCount: 1,
        lastDrawnAt: row.redeemed_at || "",
      });
    }
    drawersByCard.set(row.card_id, cardDrawers);
  }

  const totalWeight = cards.reduce(
    (sum, c) => sum + Number(c.drop_rate || 0),
    0
  );

  const cardStats = cards.map((card) => {
    const actualCount = drawCounts.get(card.id) || 0;
    const allDrawers = Array.from(
      drawersByCard.get(card.id)?.values() || []
    ).sort(
      (a, b) =>
        b.drawCount - a.drawCount ||
        // redeemed_at が NULL のとき lastDrawnAt は "" になりうる。
        // Date.parse("") は NaN でソート比較が不定になるため 0 にフォールバック。
        ((Date.parse(b.lastDrawnAt) || 0) - (Date.parse(a.lastDrawnAt) || 0))
    );
    return {
      cardId: card.id,
      cardName: card.name,
      rarity: card.rarity,
      imageUrl: card.image_url,
      configuredRate:
        totalWeight > 0 ? (Number(card.drop_rate || 0) / totalWeight) * 100 : 0,
      actualCount,
      actualRate: totalDraws > 0 ? (actualCount / totalDraws) * 100 : 0,
      drawerCount: allDrawers.length,
      drawers: allDrawers.slice(0, STATS_USERS_PER_CARD_LIMIT),
    };
  });

  // レアリティ別集計は履歴←cards の join から引く（RPC migration 00038 と同じく
  // is_active 非依存）。非アクティブ化済みカードの過去排出も RPC と同様に計上される。
  const rarityCounts = new Map<string, number>();
  for (const row of history) {
    const rarity = row.cards?.rarity;
    if (rarity) {
      rarityCounts.set(rarity, (rarityCounts.get(rarity) || 0) + 1);
    }
  }
  const rarityStats = FIXED_RARITIES.map((rarity) => {
    const count = rarityCounts.get(rarity) || 0;
    return {
      rarity,
      count,
      rate: totalDraws > 0 ? (count / totalDraws) * 100 : 0,
    };
  });

  return { totalDraws, cardStats, rarityStats };
}

/**
 * Get gacha statistics for a streamer within a given period
 * Query gacha_history filtered by streamer_id and date range,
 * then compare actual draw counts against configured drop_rate
 * 配信者向け: 指定期間のガチャ統計を取得
 * streamer_idと期間でガチャ履歴をフィルタし、
 * 実際の排出回数と設定された排出率を比較
 */
export async function getGachaStats(
  streamerId: string,
  period: "7d" | "30d"
): Promise<GachaStatsResult> {
  const supabaseAdmin = getSupabaseAdmin();
  const now = new Date();
  const daysAgo = period === "7d" ? 7 : 30;
  const fromDate = new Date(now.getTime() - daysAgo * 24 * 60 * 60 * 1000);
  const fromDateIso = fromDate.toISOString();

  // 所持ユーザーの全件フェッチ(user_cards .range(0,9999))は廃止。
  // 期間タブでは「その期間にそのカードを引いたユーザー」を
  // get_gacha_drop_stats が gacha_history からDB側で集計して返す。
  // 全期間の所持ユーザーは「カード別」タブ(getGachaCardOwnerStats)に分離。
  //
  // #573: pg 直結分岐は「RPC を実行して { data, error } を得る」2箇所だけ
  // （executeDashboardRpcPg の doc コメント参照）。executeDashboardRpcPg は
  // エラーを reject せず { data, error } に正規化するため、Promise.all が
  // 片方の失敗でもう片方を巻き込むことはない（PostgREST の独立した2結果と
  // 同じ性質）。以降のパース・42883 警告・reportError・履歴集計フォールバック
  // （fetchGachaDropStatsFromHistory / fetchChannelPointUsageStatsFromHistory は
  // 本番実績のある postgrest 実装のまま）は両経路で完全に共有される。
  // 引数リスト・値は既存 .rpc() 呼び出しと同一に揃え、uuid / timestamptz /
  // integer は明示キャストで型解決を固定する（gacha.ts と同じ規約）。
  const [dropStatsResult, channelPointResult] = isPgReadEnabled()
    ? await Promise.all([
        executeDashboardRpcPg("get_gacha_drop_stats(pg)", async (sql) => {
          // migration 00038/00050/00052: RETURNS JSONB
          // ({ total_draws, card_stats: [...], rarity_stats: [...] })
          const rows = await sql<{ result: unknown }[]>`
            select get_gacha_drop_stats(
              p_streamer_id => ${streamerId}::uuid,
              p_from_date => ${fromDateIso}::timestamptz
            ) as result
          `;
          return rows[0]?.result ?? null;
        }),
        executeDashboardRpcPg("get_channel_point_usage_stats(pg)", async (sql) => {
          // migration 00036/00039: RETURNS JSONB ({ total_points, ranking: [...] })
          const rows = await sql<{ result: unknown }[]>`
            select get_channel_point_usage_stats(
              p_streamer_id => ${streamerId}::uuid,
              p_from_date => ${null}::timestamptz,
              p_limit => ${10}::integer
            ) as result
          `;
          return rows[0]?.result ?? null;
        }),
      ])
    : await Promise.all([
        supabaseAdmin
          .rpc("get_gacha_drop_stats", {
            p_streamer_id: streamerId,
            p_from_date: fromDateIso,
          }),
        supabaseAdmin
          .rpc("get_channel_point_usage_stats", {
            p_streamer_id: streamerId,
            p_from_date: null,
            p_limit: 10,
          }),
      ]);

  // RPC が使えない場合（未デプロイ=42883 や実行時エラー）は履歴から直接集計する。
  // ここで握り潰すと配信者には恒久的に「データなし」と誤表示されるため、
  // channelPointStats と同様にエラーを可観測化したうえでフォールバックする。
  let dropStats = parseGachaDropStatsRpc(dropStatsResult.data);
  if (!dropStats) {
    if (dropStatsResult.error?.code === "42883") {
      logger.warn(
        "get_gacha_drop_stats not deployed, falling back to history aggregation"
      );
    } else if (dropStatsResult.error) {
      reportError(
        new Error(
          `get_gacha_drop_stats RPC failed: ${dropStatsResult.error.message}`
        )
      );
    } else {
      // エラーは無いが parse が null = 旧スキーマ(drawers 欠落)。
      // 00052 デプロイ完了までの過渡期。履歴集計でドロワーを補う。
      logger.warn(
        "get_gacha_drop_stats returned stale schema (no drawers), falling back to history aggregation"
      );
    }
    dropStats = await fetchGachaDropStatsFromHistory(
      supabaseAdmin,
      streamerId,
      fromDateIso
    );
  }
  const channelPointStats =
    parseChannelPointUsageStatsRpc(channelPointResult.data) ||
    await fetchChannelPointUsageStatsFromHistory(supabaseAdmin, streamerId, 10);

  if (!parseChannelPointUsageStatsRpc(channelPointResult.data)) {
    if (channelPointResult.error?.code === "42883") {
      logger.warn("get_channel_point_usage_stats not deployed, falling back to history aggregation");
    } else if (channelPointResult.error) {
      reportError(new Error(`get_channel_point_usage_stats RPC failed: ${channelPointResult.error.message}`));
    }
  }

  return { ...dropStats, channelPointStats };
}

/**
 * Get all-time per-card owner statistics for a streamer ("by card" tab).
 * Reads the trigger-maintained card_owner_stats aggregation table via RPC
 * instead of fetching every user_cards row on each request.
 * 配信者向け: 「カード別」タブ用の全期間カード別所持ユーザー統計を取得。
 * リクエストごとに user_cards を全件フェッチせず、トリガーで維持される
 * 集計テーブル card_owner_stats を RPC 経由で読むことでDB負荷を下げる。
 */
export async function getGachaCardOwnerStats(
  streamerId: string
): Promise<GachaCardOwnerStatsResult> {
  const supabaseAdmin = getSupabaseAdmin();

  // #573: pg 直結分岐は「RPC を実行して { data, error } を得る」1箇所だけ
  // （executeDashboardRpcPg の doc コメント参照）。以降のパース・42883 警告・
  // reportError・user_cards 集計フォールバック（fetchCardOwnerStatsFromUserCards
  // は本番実績のある postgrest 実装のまま）は両経路で完全に共有される。
  // 引数リストは既存 .rpc() 呼び出しと同一（p_streamer_id のみ。p_limit_per_card は
  // DEFAULT に任せる）。uuid 引数は明示キャストで型解決を固定する。
  const rpcResult = isPgReadEnabled()
    ? await executeDashboardRpcPg("get_card_owner_stats(pg)", async (sql) => {
        // migration 00051: RETURNS JSONB ({ card_stats: [...] })
        const rows = await sql<{ result: unknown }[]>`
          select get_card_owner_stats(
            p_streamer_id => ${streamerId}::uuid
          ) as result
        `;
        return rows[0]?.result ?? null;
      })
    : await supabaseAdmin.rpc("get_card_owner_stats", {
        p_streamer_id: streamerId,
      });

  const parsed = parseCardOwnerStatsRpc(rpcResult.data);
  if (parsed) {
    return parsed;
  }

  // RPC が未デプロイ(42883)/実行時エラーの場合は、旧来の user_cards 集計に
  // フォールバックして「データなし」の誤表示を防ぐ。
  if (rpcResult.error?.code === "42883") {
    logger.warn(
      "get_card_owner_stats not deployed, falling back to user_cards aggregation"
    );
  } else if (rpcResult.error) {
    reportError(
      new Error(`get_card_owner_stats RPC failed: ${rpcResult.error.message}`)
    );
  }
  return fetchCardOwnerStatsFromUserCards(supabaseAdmin, streamerId);
}

function parseCardOwnerStatsRpc(
  rpcResult: unknown
): GachaCardOwnerStatsResult | null {
  if (!rpcResult || typeof rpcResult !== "object") return null;

  const payload = rpcResult as {
    card_stats?: CardOwnerStatsRpcCardRow[] | null;
  };
  if (!Array.isArray(payload.card_stats)) return null;

  return {
    cardStats: payload.card_stats.map((row) => ({
      cardId: row.card_id,
      cardName: row.card_name,
      rarity: row.rarity,
      imageUrl: row.image_url,
      ownerCount: Number(row.owner_count || 0),
      owners: (Array.isArray(row.owners) ? row.owners : []).map((o) => ({
        userTwitchId: o.user_twitch_id,
        username: o.username || o.user_twitch_id,
        displayName: o.display_name || o.username || o.user_twitch_id,
        ownedCount: Number(o.owned_count || 0),
        lastObtainedAt: o.last_obtained_at || "",
      })),
    })),
  };
}

/**
 * Fallback all-time owner aggregation computed directly from user_cards.
 * Mirrors the pre-aggregation-table behavior so the "by card" tab keeps
 * working when get_card_owner_stats (00051) is not yet deployed.
 * get_card_owner_stats 未デプロイ時のフォールバック。集計テーブル導入前と
 * 同じく user_cards から直接集計する（PostgREST 行上限対策で上限1万件）。
 */
async function fetchCardOwnerStatsFromUserCards(
  supabaseAdmin: ReturnType<typeof getSupabaseAdmin>,
  streamerId: string
): Promise<GachaCardOwnerStatsResult> {
  const [cardsResult, ownerResult] = await Promise.all([
    supabaseAdmin
      .from("cards")
      .select("id, name, rarity, image_url, rarity_order, created_at")
      .eq("streamer_id", streamerId)
      .eq("is_active", true)
      .order("rarity_order", { ascending: true })
      .order("created_at", { ascending: false }),
    supabaseAdmin
      .from("user_cards")
      .select(`
        card_id,
        obtained_at,
        users!inner(twitch_user_id, twitch_username, twitch_display_name),
        cards!inner(streamer_id, is_active)
      `)
      .eq("cards.streamer_id", streamerId)
      .eq("cards.is_active", true)
      .range(0, 9999),
  ]);

  if (cardsResult.error || ownerResult.error) {
    reportError(
      new Error(
        `card owner stats fallback query failed: ${
          cardsResult.error?.message || ownerResult.error?.message
        }`
      )
    );
    return { cardStats: [] };
  }

  const cards = (cardsResult.data || []) as Array<{
    id: string;
    name: string;
    rarity: string;
    image_url: string | null;
  }>;

  const ownersByCard = new Map<string, Map<string, GachaCardOwner>>();
  for (const row of (ownerResult.data || []) as GachaCardOwnerStatsOwnerRow[]) {
    const user = Array.isArray(row.users) ? row.users[0] : row.users;
    if (!user) continue;

    const cardOwners = ownersByCard.get(row.card_id) || new Map();
    const existing = cardOwners.get(user.twitch_user_id);
    if (existing) {
      existing.ownedCount += 1;
      if (row.obtained_at > existing.lastObtainedAt) {
        existing.lastObtainedAt = row.obtained_at;
      }
    } else {
      cardOwners.set(user.twitch_user_id, {
        userTwitchId: user.twitch_user_id,
        username: user.twitch_username || user.twitch_user_id,
        displayName:
          user.twitch_display_name ||
          user.twitch_username ||
          user.twitch_user_id,
        ownedCount: 1,
        lastObtainedAt: row.obtained_at,
      });
    }
    ownersByCard.set(row.card_id, cardOwners);
  }

  return {
    cardStats: cards.map((card) => {
      const owners = Array.from(
        ownersByCard.get(card.id)?.values() || []
      ).sort(
        (a, b) =>
          b.ownedCount - a.ownedCount ||
          // obtained_at が NULL のとき lastObtainedAt は "" になりうるため
          // Date.parse の NaN を 0 にフォールバックして比較を安定させる。
          ((Date.parse(b.lastObtainedAt) || 0) -
            (Date.parse(a.lastObtainedAt) || 0))
      );
      return {
        cardId: card.id,
        cardName: card.name,
        rarity: card.rarity,
        imageUrl: card.image_url,
        // ownerCount は総数（打ち切り前）、owners はRPCと同じく上限件数で打ち切る
        ownerCount: owners.length,
        owners: owners.slice(0, STATS_USERS_PER_CARD_LIMIT),
      };
    }),
  };
}

/**
 * fetchActiveCardsForStreamerFromDB の Drizzle（pg 直結）実装 (#571)
 *
 * フラグ分岐は unstable_cache の「中」（fetchActiveCardsForStreamerFromDB 冒頭）
 * で行うため、キャッシュキー・タグ・TTL の構造は両経路で完全に同一
 * （getActiveCardsForStreamer 側は無変更）。
 *
 * LIMIT 1000 の根拠: 既存 PostgREST 経路は Supabase 既定の max-rows=1000 で
 * トップレベル行が暗黙に打ち切られる。1配信者のアクティブカードが 1000 を
 * 超えることは実運用上考えにくいが、アプリ層に枚数上限の不変条件が無いため、
 * 超えた場合の挙動も既存経路と一致するよう明示的に LIMIT 1000 を付ける
 * （挙動パリティ優先。上限撤廃は移行完了後に別途判断する）。
 * エラー時は既存実装（分割代入で握り潰し → cards=null → []）と同じ外部挙動。
 */
// Issue #685: 無指定 select() は cards の本番未デプロイ8列を要求する。
// 列欠落エラーなら CARDS_SAFE_COLUMNS へ差し替えて再試行する。
async function selectActiveCardsForStreamer(streamerId: string, useSafeColumns: boolean) {
  return withDbRetry(
    async () => {
      const { db } = await getDb();
      const query = useSafeColumns ? db.select(CARDS_SAFE_COLUMNS) : db.select();
      return query
        .from(cardsTable)
        .where(and(eq(cardsTable.streamer_id, streamerId), eq(cardsTable.is_active, true)))
        // generated column rarity_order によるレアリティ順の安定ソート
        // （PostgREST 版と同一。asc/desc の NULL 順序は両経路とも PostgreSQL
        // 既定（ASC=NULLS LAST / DESC=NULLS FIRST）で一致する）
        .orderBy(asc(cardsTable.rarity_order), desc(cardsTable.created_at))
        .limit(1000);
    },
    "getActiveCardsForStreamer",
    { idempotent: true },
  );
}

async function fetchActiveCardsForStreamerFromDBPg(streamerId: string): Promise<Card[]> {
  const startTotal = Date.now();
  const startQuery = Date.now();
  try {
    const cards = await withCardsBattleColumnFallback((useSafeColumns) =>
      selectActiveCardsForStreamer(streamerId, useSafeColumns)
    );
    logger.info(`[Perf] getActiveCardsForStreamer query: ${Date.now() - startQuery}ms`);
    logger.info(`[Perf] getActiveCardsForStreamer total: ${Date.now() - startTotal}ms`);
    return normalizeDropRate(cards as unknown as Card[]);
  } catch (error) {
    logger.error("Error in getActiveCardsForStreamer (pg)", { error });
    return [];
  }
}

/**
 * Internal function to fetch active cards for a specific streamer from database
 * 内部関数: 特定配信者のアクティブカードをデータベースから取得
 */
async function fetchActiveCardsForStreamerFromDB(streamerId: string): Promise<Card[]> {
  // #571: pg 直結経路。unstable_cache の内側で分岐することでキャッシュ構造を
  // 変えない（フラグ未設定時は素通り。getStreamerDataPg 参照）
  if (isPgReadEnabled()) {
    return fetchActiveCardsForStreamerFromDBPg(streamerId);
  }

  const startTotal = Date.now();
  const supabaseAdmin = getSupabaseAdmin();

  const startQuery = Date.now();
  // Use generated column rarity_order for stable rarity sorting
  // generated columnのrarity_orderを使用してレアリティ順で安定ソート
  const { data: cards } = await supabaseAdmin
    .from("cards")
    .select("*")
    .eq("streamer_id", streamerId)
    .eq("is_active", true)
    .order("rarity_order", { ascending: true })
    .order("created_at", { ascending: false });
  logger.info(`[Perf] getActiveCardsForStreamer query: ${Date.now() - startQuery}ms`);

  logger.info(`[Perf] getActiveCardsForStreamer total: ${Date.now() - startTotal}ms`);
  return normalizeDropRate(cards || []);
}

/**
 * Get active cards for a specific streamer - cached with Next.js cache (30 seconds TTL)
 * 特定配信者のアクティブカード取得 - Next.jsキャッシュ使用（30秒TTL）
 */
export const getActiveCardsForStreamer = cache(async (
  streamerId: string
): Promise<Card[]> => {
  const start = Date.now();

  const cachedFetch = unstable_cache(
    async () => fetchActiveCardsForStreamerFromDB(streamerId),
    [`active-cards-${streamerId}`],
    { revalidate: 30, tags: [`active-cards-${streamerId}`] }
  );

  const result = await cachedFetch();
  logger.info(`[Perf] getActiveCardsForStreamer (with cache): ${Date.now() - start}ms`);
  return result;
});

export interface ActiveCardCountForStreamer {
  totalActive: number;
  activeCardIds: Set<string>;
}

/**
 * getActiveCardCountsForStreamers の Drizzle（pg 直結）実装 (#571)
 *
 * 前処理（重複除去・空入力の早期 return）と JS 側集計は経路非依存だが、
 * 「関数冒頭でのフラグ分岐 + 既存実装無変更」の規約を守るため、pg 版にも
 * 同じ前処理を意図的に複製している（挙動パリティの検証容易性を優先）。
 *
 * LIMIT 1000 の根拠: 既存 PostgREST 経路は max-rows=1000 でトップレベル行が
 * 暗黙に打ち切られる。この関数は複数配信者のアクティブカードを合算で取得する
 * ため、コレクションの多いユーザーでは 1000 行超が現実に起こりうる。ここで
 * LIMIT を外すと pg 経路だけカウントが変わってしまうため、明示 LIMIT 1000 で
 * 既存挙動（打ち切りによる過少カウントも含めて）を再現する。
 * エラー時は既存実装と同じく reportError + 全ゼロの counts を返す。
 */
async function getActiveCardCountsForStreamersPg(
  streamerIds: string[]
): Promise<Map<string, ActiveCardCountForStreamer>> {
  const startedAt = perfStart();
  const uniqueStreamerIds = Array.from(new Set(streamerIds.filter(Boolean)));
  const counts = new Map<string, ActiveCardCountForStreamer>();
  for (const streamerId of uniqueStreamerIds) {
    counts.set(streamerId, { totalActive: 0, activeCardIds: new Set() });
  }

  if (uniqueStreamerIds.length === 0) {
    logPerf("dashboard-data", "getActiveCardCountsForStreamers", startedAt, { streamerCount: 0 });
    return counts;
  }

  let data: Array<{ id: string; streamer_id: string }>;
  try {
    data = await withDbRetry(
      async () => {
        const { db } = await getDb();
        return db
          .select({ id: cardsTable.id, streamer_id: cardsTable.streamer_id })
          .from(cardsTable)
          .where(
            and(
              inArray(cardsTable.streamer_id, uniqueStreamerIds),
              eq(cardsTable.is_active, true),
            )
          )
          .limit(1000);
      },
      "getActiveCardCountsForStreamers",
      { idempotent: true },
    );
  } catch (error) {
    reportError(
      new Error(
        `active card count batch query failed: ${error instanceof Error ? error.message : String(error)}`
      )
    );
    logPerf("dashboard-data", "getActiveCardCountsForStreamers", startedAt, {
      streamerCount: uniqueStreamerIds.length,
      failed: true,
    });
    return counts;
  }

  for (const row of data) {
    const entry = counts.get(row.streamer_id);
    if (!entry) continue;
    entry.totalActive += 1;
    entry.activeCardIds.add(row.id);
  }

  logPerf("dashboard-data", "getActiveCardCountsForStreamers", startedAt, {
    streamerCount: uniqueStreamerIds.length,
    activeCardCount: data.length,
  });
  return counts;
}

export async function getActiveCardCountsForStreamers(
  streamerIds: string[]
): Promise<Map<string, ActiveCardCountForStreamer>> {
  // #571: pg 直結経路（フラグ未設定時は素通り。getStreamerDataPg 参照）
  if (isPgReadEnabled()) {
    return getActiveCardCountsForStreamersPg(streamerIds);
  }

  const startedAt = perfStart();
  const uniqueStreamerIds = Array.from(new Set(streamerIds.filter(Boolean)));
  const counts = new Map<string, ActiveCardCountForStreamer>();
  for (const streamerId of uniqueStreamerIds) {
    counts.set(streamerId, { totalActive: 0, activeCardIds: new Set() });
  }

  if (uniqueStreamerIds.length === 0) {
    logPerf("dashboard-data", "getActiveCardCountsForStreamers", startedAt, { streamerCount: 0 });
    return counts;
  }

  const supabaseAdmin = getSupabaseAdmin();
  const { data, error } = await withRetry(
    () => supabaseAdmin
      .from("cards")
      .select("id, streamer_id")
      .in("streamer_id", uniqueStreamerIds)
      .eq("is_active", true),
    "getActiveCardCountsForStreamers",
  );

  if (error) {
    reportError(new Error(`active card count batch query failed: ${error.message}`));
    logPerf("dashboard-data", "getActiveCardCountsForStreamers", startedAt, {
      streamerCount: uniqueStreamerIds.length,
      failed: true,
    });
    return counts;
  }

  for (const row of (data || []) as Array<{ id: string; streamer_id: string }>) {
    const entry = counts.get(row.streamer_id);
    if (!entry) continue;
    entry.totalActive += 1;
    entry.activeCardIds.add(row.id);
  }

  logPerf("dashboard-data", "getActiveCardCountsForStreamers", startedAt, {
    streamerCount: uniqueStreamerIds.length,
    activeCardCount: data?.length ?? 0,
  });
  return counts;
}

/**
 * Internal function to fetch user cards for a specific streamer from database
 * RPC get_user_card_counts (p_streamer_id付き) でDB側集計を行う
 * RPC未デプロイ時は直接クエリにフォールバック
 *
 * 内部関数: 特定の配信者のユーザーカードをデータベースから取得
 */
async function fetchUserCardsForStreamerFromDB(
  twitchUserId: string,
  streamerId: string
): Promise<CardWithDetails[]> {
  const startTotal = Date.now();
  const supabaseAdmin = getSupabaseAdmin();

  // RPC: DB側でGROUP BY集計 + streamer_idフィルタ
  const startQuery = Date.now();
  // #573: pg 直結分岐は「RPC を実行して { data, error } を得る」1箇所だけ。
  // 成功時パース・42883 分岐・その他エラー分岐と postgrest 直接クエリ
  // フォールバックの共有方針は fetchUserCardsFromDB の分岐コメント参照。
  // uuid 引数（p_streamer_id）は明示キャストで型解決を固定する。
  const { data: rpcResult, error: rpcError } = isPgReadEnabled()
    ? await executeDashboardRpcPg("get_user_card_counts_for_streamer(pg)", async (sql) => {
        // migration 00031: RETURNS JSONB（{ count, card, streamer } の行配列）
        const rows = await sql<{ result: unknown }[]>`
          select get_user_card_counts(
            p_twitch_user_id => ${twitchUserId},
            p_streamer_id => ${streamerId}::uuid
          ) as result
        `;
        return rows[0]?.result ?? null;
      })
    : await withRetry(
        () => supabaseAdmin.rpc("get_user_card_counts", {
          p_twitch_user_id: twitchUserId,
          p_streamer_id: streamerId,
        }),
        "get_user_card_counts_for_streamer",
      );

  if (!rpcError) {
    logger.info(`[Perf] getUserCardsForStreamer RPC: ${Date.now() - startQuery}ms`);
    const cards = parseRpcCardCounts(rpcResult);
    logger.info(`[Perf] getUserCardsForStreamer total: ${Date.now() - startTotal}ms`);
    return cards;
  }

  // RPCエラー時は直接クエリにフォールバック（DB一時障害でもカード空表示を防ぐ）
  // TODO: マイグレーション適用確認後にフォールバックを削除
  if (rpcError.code === "42883") {
    logger.warn("get_user_card_counts not deployed, falling back to direct query");
  } else {
    reportError(new Error(`get_user_card_counts RPC failed: ${rpcError.message}`));
  }

  const { data: user } = await supabaseAdmin
    .from("users")
    .select("id")
    .eq("twitch_user_id", twitchUserId)
    .maybeSingle();

  if (!user) {
    logger.info(`[Perf] getUserCardsForStreamer total (no user): ${Date.now() - startTotal}ms`);
    return [];
  }

  // streamers の埋め込みは FK 制約名で一意化する（getStreamerData と同じ理由:
  // migration 00051 の card_owner_stats が cards↔streamers を m2m にも見せるため、
  // ヒントなしの streamers(*) は PGRST201 で失敗する）。
  const { data: userCards } = await supabaseAdmin
    .from("user_cards")
    .select("card_id, cards!inner(*, streamers!cards_streamer_id_fkey!inner(*))")
    .eq("user_id", user.id)
    .eq("cards.streamer_id", streamerId)
    .range(0, 9999);
  logger.info(`[Perf] getUserCardsForStreamer query: ${Date.now() - startQuery}ms`);

  if (!userCards || userCards.length === 0) {
    logger.info(`[Perf] getUserCardsForStreamer total (no data): ${Date.now() - startTotal}ms`);
    return [];
  }

  const cardMap = new Map<string, CardWithDetails>();

  for (const uc of userCards) {
    const card = uc.cards as unknown as Card & { streamers: Streamer };
    if (!card) continue;

    const existing = cardMap.get(card.id);
    if (existing) {
      existing.count++;
    } else {
      cardMap.set(card.id, {
        ...card,
        streamer: card.streamers,
        count: 1,
      });
    }
  }

  logger.info(`[Perf] getUserCardsForStreamer total: ${Date.now() - startTotal}ms`);
  return Array.from(cardMap.values());
}

/**
 * Get user's card collection for a specific streamer - cached with Next.js cache (30 seconds TTL)
 * 特定の配信者のユーザーカードコレクション取得 - Next.jsキャッシュ使用（30秒TTL）
 */
export const getUserCardsForStreamer = cache(async (
  twitchUserId: string,
  streamerId: string
): Promise<CardWithDetails[]> => {
  const start = Date.now();

  // Use Next.js cache with 30 second revalidation
  // Next.jsキャッシュを使用（30秒で再検証）
  const cachedFetch = unstable_cache(
    async () => fetchUserCardsForStreamerFromDB(twitchUserId, streamerId),
    [`user-cards-${twitchUserId}-${streamerId}`],
    { revalidate: 30, tags: [`user-cards-${twitchUserId}-${streamerId}`] }
  );

  const result = await cachedFetch();
  logger.info(`[Perf] getUserCardsForStreamer (with cache): ${Date.now() - start}ms`);
  return result;
});

/**
 * getStreamerById の Drizzle（pg 直結）実装 (#571)
 *
 * .maybeSingle() 相当: id は主キーのため最大1行。0行なら null。
 * streamerId は URL パラメータ由来で不正な UUID 文字列が渡りうるが、その場合は
 * PostgreSQL が 22P02 を返す。既存 PostgREST 経路も同様にエラー → data=null →
 * null を返すため、pg 版も catch して null に落とす（外部挙動のパリティ）。
 */
async function getStreamerByIdPg(streamerId: string): Promise<Streamer | null> {
  try {
    const rows = await withDbRetry(
      async () => {
        const { db } = await getDb();
        return db
          .select()
          .from(streamersTable)
          .where(eq(streamersTable.id, streamerId))
          .limit(1);
      },
      "getStreamerById",
      { idempotent: true },
    );
    // 既存の戻り値型に合わせるキャスト（値の変換はしない。getStreamerDataPg 参照）
    return (rows[0] ?? null) as unknown as Streamer | null;
  } catch (error) {
    logger.error("Error in getStreamerById (pg)", { error });
    return null;
  }
}

/**
 * Get streamer info by ID
 * 配信者IDから配信者情報を取得
 */
export const getStreamerById = cache(async (streamerId: string): Promise<Streamer | null> => {
  // #571: pg 直結経路（フラグ未設定時は素通り。getStreamerDataPg 参照）
  if (isPgReadEnabled()) {
    return getStreamerByIdPg(streamerId);
  }

  const supabaseAdmin = getSupabaseAdmin();

  const { data: streamer } = await supabaseAdmin
    .from("streamers")
    .select("*")
    .eq("id", streamerId)
    .maybeSingle();

  return streamer;
});

/**
 * getUserCardDetail の Drizzle（pg 直結）実装 (#571)
 *
 * PostgREST 実装との対応（3クエリ構成をそのまま踏襲）:
 * 1. cards + streamers 埋め込み: `*, streamers!cards_streamer_id_fkey(*)` は
 *    cards.streamer_id → streamers.id の多対一 FK に基づく単一オブジェクト埋め込み。
 *    LEFT JOIN + ネスト選択（streamers: streamersTable）で同じ形状を得る。
 *    重要: 既存実装は `{ ...cardWithStreamer, streamer, count }` と spread で返す
 *    ため、戻り値には埋め込みキー `streamers` が残る。pg 版も同じ spread 構成に
 *    して実行時形状（streamers と streamer の両方を含む）を厳密に一致させる。
 * 2. users: twitch_user_id は UNIQUE のため LIMIT 1 で .maybeSingle() と同挙動。
 * 3. user_cards の所持数: `{ count: "exact", head: true }` 相当の COUNT(*)。
 *
 * エラー時の挙動は既存実装（各クエリのエラーを分割代入で握り潰す）に合わせ、
 * クエリ単位で catch して null / 0 に落とし、後続の [Perf] ログと return null の
 * 流れ（card not found / user not found / user doesn't own card）を共有する。
 * cardId / streamerId は URL 由来で不正 UUID がありうる（22P02 → null）。
 */
async function getUserCardDetailPg(
  twitchUserId: string,
  streamerId: string,
  cardId: string
): Promise<CardWithDetails | null> {
  const start = Date.now();

  // Issue #685: getTableColumns(cardsTable) は cards の本番未デプロイ8列を
  // 要求する。列欠落エラーなら CARDS_SAFE_COLUMNS へ差し替えて再試行する。
  async function selectCardDetail(useSafeColumns: boolean) {
    return withDbRetry(
      async () => {
        const { db } = await getDb();
        return db
          .select({
            ...(useSafeColumns ? CARDS_SAFE_COLUMNS : getTableColumns(cardsTable)),
            streamers: streamersTable,
          })
          .from(cardsTable)
          .leftJoin(streamersTable, eq(cardsTable.streamer_id, streamersTable.id))
          // id は主キーのため最大1行（LIMIT 1 は .maybeSingle() と同挙動）
          .where(and(eq(cardsTable.id, cardId), eq(cardsTable.streamer_id, streamerId)))
          .limit(1);
      },
      "getUserCardDetail(card)",
      { idempotent: true },
    );
  }

  let card: (Card & { streamers: Streamer }) | null;
  try {
    const rows = await withCardsBattleColumnFallback(selectCardDetail);
    // streamer_id は NOT NULL FK のため streamers は実データで常に非 null。
    // 既存の消費形状（Card & { streamers: Streamer }）へのキャストのみ行う。
    card = (rows[0] ?? null) as unknown as (Card & { streamers: Streamer }) | null;
  } catch (error) {
    logger.error("Error in getUserCardDetail (pg:card)", { error });
    card = null;
  }

  if (!card) {
    logger.info(`[Perf] getUserCardDetail (card not found): ${Date.now() - start}ms`);
    return null;
  }

  let user: { id: string } | null;
  try {
    const rows = await withDbRetry(
      async () => {
        const { db } = await getDb();
        return db
          .select({ id: usersTable.id })
          .from(usersTable)
          .where(eq(usersTable.twitch_user_id, twitchUserId))
          .limit(1);
      },
      "getUserCardDetail(user)",
      { idempotent: true },
    );
    user = rows[0] ?? null;
  } catch (error) {
    logger.error("Error in getUserCardDetail (pg:user)", { error });
    user = null;
  }

  if (!user) {
    logger.info(`[Perf] getUserCardDetail (user not found): ${Date.now() - start}ms`);
    return null;
  }
  // クロージャ内での TS null 絞り込みを保つため id を確定させる
  const userId = user.id;

  let ownershipCount = 0;
  try {
    ownershipCount = await withDbRetry(
      async () => {
        const { db } = await getDb();
        const result = await db
          .select({ count: countRows() })
          .from(userCardsTable)
          .where(and(eq(userCardsTable.user_id, userId), eq(userCardsTable.card_id, cardId)));
        return result[0]?.count ?? 0;
      },
      "getUserCardDetail(count)",
      { idempotent: true },
    );
  } catch (error) {
    // 既存実装は count エラー時 null → `count ?? 0` で 0 扱い（= 未所持と同じ）
    logger.error("Error in getUserCardDetail (pg:count)", { error });
    ownershipCount = 0;
  }

  if (ownershipCount === 0) {
    logger.info(`[Perf] getUserCardDetail (user doesn't own card): ${Date.now() - start}ms`);
    return null;
  }

  logger.info(`[Perf] getUserCardDetail: ${Date.now() - start}ms`);

  // 既存実装と同一の spread 構成（streamers キーも残る）
  return {
    ...card,
    streamer: card.streamers,
    count: ownershipCount,
  };
}

/**
 * Get a specific user's card with details
 * Returns the card with count (how many the user owns) if the user owns it, null otherwise
 * 特定のユーザーのカード情報を詳細付きで取得
 * ユーザーが所有している場合はカウント（所有枚数）付きで返し、所有していない場合はnullを返す
 */
export const getUserCardDetail = cache(async (
  twitchUserId: string,
  streamerId: string,
  cardId: string
): Promise<CardWithDetails | null> => {
  // #571: pg 直結経路（フラグ未設定時は素通り。getStreamerDataPg 参照）
  if (isPgReadEnabled()) {
    return getUserCardDetailPg(twitchUserId, streamerId, cardId);
  }

  const start = Date.now();
  const supabaseAdmin = getSupabaseAdmin();

  // Get the card with streamer info to verify it belongs to the streamer
  // カードと配信者情報を取得して、配信者のものかどうかを確認
  // streamers の埋め込みは FK 制約名で一意化する（getStreamerData と同じ理由:
  // migration 00051 の card_owner_stats が cards↔streamers を m2m にも見せるため、
  // ヒントなしの streamers(*) は PGRST201 で失敗する）。
  const { data: card } = await supabaseAdmin
    .from("cards")
    .select(`
      *,
      streamers!cards_streamer_id_fkey (*)
    `)
    .eq("id", cardId)
    .eq("streamer_id", streamerId)
    .maybeSingle();

  if (!card) {
    logger.info(`[Perf] getUserCardDetail (card not found): ${Date.now() - start}ms`);
    return null;
  }

  // ユーザーの内部IDを取得
  const { data: user } = await supabaseAdmin
    .from("users")
    .select("id")
    .eq("twitch_user_id", twitchUserId)
    .maybeSingle();

  if (!user) {
    logger.info(`[Perf] getUserCardDetail (user not found): ${Date.now() - start}ms`);
    return null;
  }

  // user_cards を直接カウント（データ転送なし、行数制限の影響なし）
  const { count } = await supabaseAdmin
    .from("user_cards")
    .select("id", { count: "exact", head: true })
    .eq("user_id", user.id)
    .eq("card_id", cardId);

  const ownershipCount = count ?? 0;

  // If user doesn't own this card, return null
  // ユーザーがこのカードを所有していない場合はnullを返す
  if (ownershipCount === 0) {
    logger.info(`[Perf] getUserCardDetail (user doesn't own card): ${Date.now() - start}ms`);
    return null;
  }

  logger.info(`[Perf] getUserCardDetail: ${Date.now() - start}ms`);

  const cardWithStreamer = card as unknown as Card & { streamers: Streamer };
  return {
    ...cardWithStreamer,
    streamer: cardWithStreamer.streamers,
    count: ownershipCount,
  };
});

/**
 * PostgreSQL unique-constraint violation. Issue #557: completion records are
 * now written with a plain INSERT and this code is silently ignored, because
 * migration 00064 replaced the table's UNIQUE constraint with two PARTIAL
 * unique indexes — PostgREST's upsert (`ON CONFLICT (cols)`) cannot infer a
 * partial index as its conflict target, so upsert+ignoreDuplicates would
 * error on every write. A pre-INSERT SELECT is no substitute either (two
 * concurrent page loads could both see "not recorded yet" and both insert —
 * the DB-level unique index is the only race-free arbiter).
 */
const UNIQUE_VIOLATION_CODE = "23505";

/**
 * Shared write path for completion records (overall + per-pack).
 * INSERT + ignore 23505 (already recorded — the expected steady-state case),
 * report anything else. Never throws: エラーでページ表示を壊さない。
 */
async function insertCompletionRecord(
  row: Database["public"]["Tables"]["collection_completions"]["Insert"],
  context: string,
): Promise<void> {
  const { twitch_user_id: twitchUserId, streamer_id: streamerId, total_cards: totalCards } = row;
  try {
    const supabaseAdmin = getSupabaseAdmin();
    const { error } = await supabaseAdmin
      .from("collection_completions")
      .insert(row);
    if (!error) return;
    // Duplicate achievement (unique index hit): the normal repeat-visit case,
    // same silent outcome the previous upsert+ignoreDuplicates produced.
    if (error.code === UNIQUE_VIOLATION_CODE) return;
    // Deploy window (new code + old schema): collection_name column not
    // migrated yet. Only pack-scoped inserts ever carry the column (the
    // overall record omits it entirely for exactly this compatibility), so
    // skipping silently here loses nothing — the pack record will be written
    // on the next page view after 00064 lands.
    if ("collection_name" in row && isMissingCollectionNameColumn(error)) return;
    logger.error(`Failed to record collection completion: ${error.message}`);
    reportError(error, { context, twitchUserId, streamerId, totalCards });
  } catch (err) {
    // fire-and-forget: エラーでページ表示を壊さない
    logger.error(`Unexpected error in ${context}: ${err}`);
    reportError(err instanceof Error ? err : new Error(String(err)), {
      context, twitchUserId, streamerId, totalCards,
    });
  }
}

/**
 * Record an overall (whole-collection) completion achievement.
 * 一意インデックスにより同一total_cardsでの重複挿入はスキップされる。
 * Cloudflare Workers では void 呼び出しだと応答後に破棄されるため、
 * 呼び出し側で必ず await すること
 *
 * The insert deliberately OMITS collection_name (not even an explicit null)
 * so the identical statement works against both the pre- and post-00064
 * schema during the deploy window.
 *
 * コレクションコンプリート達成をDBに記録する
 */
export async function recordCollectionCompletion(
  twitchUserId: string,
  streamerId: string,
  totalCards: number,
): Promise<void> {
  await insertCompletionRecord(
    { twitch_user_id: twitchUserId, streamer_id: streamerId, total_cards: totalCards },
    "recordCollectionCompletion",
  );
}

/**
 * Record a pack-scoped completion achievement (Issue #557).
 * `packKey` is the card pack's collection_name, or DEFAULT_PACK_SENTINEL for
 * the default (unclassified) pseudo-pack — the sentinel is a legitimate
 * stored value in collection_completions.collection_name (see migration
 * 00064). Callers must await (same Workers constraint as above).
 *
 * パック別コンプリート達成をDBに記録する（デフォルトパックは sentinel）。
 */
export async function recordPackCompletion(
  twitchUserId: string,
  streamerId: string,
  totalCards: number,
  packKey: string,
): Promise<void> {
  await insertCompletionRecord(
    {
      twitch_user_id: twitchUserId,
      streamer_id: streamerId,
      total_cards: totalCards,
      collection_name: packKey,
    },
    "recordPackCompletion",
  );
}

export interface CollectionCompletionRecord {
  total_cards: number;
  completed_at: string;
  // 対象パック。null=全体コンプリート、DEFAULT_PACK_SENTINEL=デフォルトパック。Issue #557
  collection_name: string | null;
}

/**
 * getCollectionCompletions の Drizzle（pg 直結）実装 (#571)
 *
 * PostgREST 実装との対応:
 * - select("total_cards, completed_at, collection_name") と同じ3列の列指定 select。
 * - Issue #557 / migration 00064 のデプロイ窓（collection_name 列が未適用）では、
 *   pg 直結は PostgreSQL の 42703 (undefined_column) を throw する。既存経路が
 *   isMissingCollectionNameColumn（読み取りは 42703 を検知）で旧列リストへ
 *   フォールバックするのと同じく、pg 版は isPgMissingColumnError (SQLSTATE 42703、
 *   src/lib/db/errors.ts) でフォールバックする。このクエリで参照する列のうち
 *   00064 で追加されたのは collection_name だけなので、42703 はデプロイ窓の
 *   列欠落と一意に対応する。
 * - フォールバック行は既存実装と同じく collection_name: null を補完して返す
 *   （列が無い間はパック別レコード自体が存在し得ないため、これが唯一忠実な解釈）。
 * - その他のエラーは既存実装と同じくログして []（ページ表示を壊さない）。
 *
 * LIMIT 1000 の根拠: 既存経路は max-rows=1000 で暗黙に打ち切られる。達成記録が
 * 1000 行を超えることは実運用上まず無いが、上限の不変条件も無いため、既存挙動
 * との完全一致を優先して明示 LIMIT 1000 を付ける（fetchActiveCardsForStreamerFromDBPg
 * と同じ方針）。
 */
async function getCollectionCompletionsPg(
  twitchUserId: string,
  streamerId: string,
): Promise<CollectionCompletionRecord[]> {
  try {
    return await withDbRetry(
      async () => {
        const { db } = await getDb();
        return db
          .select({
            total_cards: collectionCompletionsTable.total_cards,
            completed_at: collectionCompletionsTable.completed_at,
            collection_name: collectionCompletionsTable.collection_name,
          })
          .from(collectionCompletionsTable)
          .where(
            and(
              eq(collectionCompletionsTable.twitch_user_id, twitchUserId),
              eq(collectionCompletionsTable.streamer_id, streamerId),
            )
          )
          .orderBy(desc(collectionCompletionsTable.completed_at))
          .limit(1000);
      },
      "dashboard:getCollectionCompletions",
      { idempotent: true },
    );
  } catch (error) {
    if (isPgMissingColumnError(error)) {
      // Deploy window fallback: 未デプロイ列を除いた旧列リストで再取得し、
      // 全行を全体コンプリート（collection_name: null）として返す
      try {
        const legacy = await withDbRetry(
          async () => {
            const { db } = await getDb();
            return db
              .select({
                total_cards: collectionCompletionsTable.total_cards,
                completed_at: collectionCompletionsTable.completed_at,
              })
              .from(collectionCompletionsTable)
              .where(
                and(
                  eq(collectionCompletionsTable.twitch_user_id, twitchUserId),
                  eq(collectionCompletionsTable.streamer_id, streamerId),
                )
              )
              .orderBy(desc(collectionCompletionsTable.completed_at))
              .limit(1000);
          },
          "dashboard:getCollectionCompletions:legacy",
          { idempotent: true },
        );
        return legacy.map((row) => ({ ...row, collection_name: null }));
      } catch (legacyError) {
        logger.error(
          `Failed to fetch collection completions (legacy): ${legacyError instanceof Error ? legacyError.message : String(legacyError)}`
        );
        return [];
      }
    }
    logger.error(
      `Failed to fetch collection completions: ${error instanceof Error ? error.message : String(error)}`
    );
    return [];
  }
}

/**
 * Get past collection completion records for a user and streamer
 * Returns records sorted by completed_at DESC (newest first)
 *
 * Issue #557: now also returns collection_name (null = overall completion,
 * pack name / DEFAULT_PACK_SENTINEL = pack-scoped). During the 00064 deploy
 * window the column doesn't exist yet, so the select falls back to the
 * legacy column list and maps every row to collection_name null — the only
 * faithful reading, since no pack-scoped row can exist without the column.
 *
 * ユーザー×配信者の過去コンプリート達成記録を取得（新しい順）
 */
export const getCollectionCompletions = cache(async (
  twitchUserId: string,
  streamerId: string,
): Promise<CollectionCompletionRecord[]> => {
  const cachedFetch = unstable_cache(
    async (): Promise<CollectionCompletionRecord[]> => {
      // #571: pg 直結経路。unstable_cache の内側で分岐することでキャッシュ
      // キー・タグ・TTL の構造を変えない（フラグ未設定時は素通り）
      if (isPgReadEnabled()) {
        return getCollectionCompletionsPg(twitchUserId, streamerId);
      }

      const supabaseAdmin = getSupabaseAdmin();
      const { data, error } = await withRetry(
        () => supabaseAdmin
          .from("collection_completions")
          .select("total_cards, completed_at, collection_name")
          .eq("twitch_user_id", twitchUserId)
          .eq("streamer_id", streamerId)
          .order("completed_at", { ascending: false }),
        "dashboard:getCollectionCompletions",
      );
      if (error) {
        if (isMissingCollectionNameColumn(error)) {
          // Deploy window fallback: re-select without the not-yet-deployed
          // column (read-path 42703) and surface rows as overall completions.
          const legacy = await withRetry(
            () => supabaseAdmin
              .from("collection_completions")
              .select("total_cards, completed_at")
              .eq("twitch_user_id", twitchUserId)
              .eq("streamer_id", streamerId)
              .order("completed_at", { ascending: false }),
            "dashboard:getCollectionCompletions:legacy",
          );
          if (legacy.error) {
            logger.error(`Failed to fetch collection completions (legacy): ${legacy.error.message}`);
            return [];
          }
          return (legacy.data || []).map((row) => ({ ...row, collection_name: null }));
        }
        logger.error(`Failed to fetch collection completions: ${error.message}`);
        return [];
      }
      return data || [];
    },
    [`collection-completions-${twitchUserId}-${streamerId}`],
    { revalidate: 30, tags: [`collection-completions-${twitchUserId}-${streamerId}`] },
  );

  return cachedFetch();
});
