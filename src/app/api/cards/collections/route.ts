import { type NextRequest, NextResponse } from "next/server";
import { getSession, canUseStreamerFeatures } from "@/lib/session";
import { handleApiError, handleDatabaseError } from "@/lib/error-handler";
import { checkRateLimit, rateLimits, getRateLimitIdentifier, retryAfterSeconds } from "@/lib/rate-limit";
import { ERROR_MESSAGES } from "@/lib/constants";
import { validateCSRFToken } from "@/lib/csrf";
import { validateContentType } from "@/lib/request-validation";
import {
  isMissingCardPackNamesColumnError,
  isMissingRenameCardPackFunctionError,
} from "@/lib/collections/collection-existence";
import { validatePackName } from "@/lib/validation/collection-name";
import type { ApiRateLimitResponse } from "@/types/api";
import { getDb } from "@/lib/db/client";
import { withDbRetry } from "@/lib/db/retry";
import { isPgFunctionNotFoundError } from "@/lib/db/errors";
import { and, eq } from "drizzle-orm";
import { streamers as streamersTable } from "@/lib/db/schema";

interface OwnedStreamerCatalogResult {
  streamer: { id: string; card_pack_names: string[] } | null;
  cardPackNamesUnavailable: boolean;
  error: unknown;
}

/**
 * 所有権確認とパック一覧を同一の PlanetScale クエリで取得する。
 *
 * ここは認可境界なので、`streamerId` 単独の検索に分離してはならない。Drizzle の
 * 値バインディングを使い、利用者が指定した ID を SQL 文字列へ連結しないことで
 * SQL injection を防ぎつつ、従来の Supabase の `.eq(...).eq(...)` と同じ
 * 「所有者でなければ存在しない」契約を維持する。
 *
 * card_pack_names の schema rollout 中だけは、既存 API と同じ挙動として所有権を
 * 再確認してから空配列を返す。PATCH は一覧がない状態で安全に rename できないため、
 * 呼び出し側が `cardPackNamesUnavailable` を 503 へ変換する。
 */
async function loadOwnedStreamerCatalog(
  streamerId: string,
  twitchUserId: string,
): Promise<OwnedStreamerCatalogResult> {
  const ownershipFilter = and(
    eq(streamersTable.id, streamerId),
    eq(streamersTable.twitch_user_id, twitchUserId),
  );

  try {
    const rows = await withDbRetry(
      async () => {
        const { db } = await getDb();
        return db
          .select({
            id: streamersTable.id,
            card_pack_names: streamersTable.card_pack_names,
          })
          .from(streamersTable)
          .where(ownershipFilter)
          .limit(1);
      },
      "cards collections: load owned catalog",
      { idempotent: true },
    );
    const row = rows[0] ?? null;
    return {
      streamer: row
        ? {
            id: row.id,
            card_pack_names: Array.isArray(row.card_pack_names) ? row.card_pack_names : [],
          }
        : null,
      cardPackNamesUnavailable: false,
      error: null,
    };
  } catch (error) {
    if (!isMissingCardPackNamesColumnError(error)) {
      return { streamer: null, cardPackNamesUnavailable: false, error };
    }

    try {
      const rows = await withDbRetry(
        async () => {
          const { db } = await getDb();
          return db
            .select({ id: streamersTable.id })
            .from(streamersTable)
            .where(ownershipFilter)
            .limit(1);
        },
        "cards collections: load ownership without catalog",
        { idempotent: true },
      );
      return {
        streamer: rows[0] ? { id: rows[0].id, card_pack_names: [] } : null,
        // 42703 は catalog 列の未展開だけを示し、行の所有までは示さない。
        // fallback が0行なら非所有者なので、PATCH が deploy-window の 503 を返して
        // リソースの存在を曖昧にしてはならない。所有者だけが 503 の対象になる。
        cardPackNamesUnavailable: Boolean(rows[0]),
        error: null,
      };
    } catch (fallbackError) {
      return { streamer: null, cardPackNamesUnavailable: false, error: fallbackError };
    }
  }
}

/**
 * rename_card_pack RPC のエラーを PostgREST .rpc() の error と同じ
 * 「code + message」形状へ正規化するための最小型(#573)。postgres.js は
 * PostgrestError と異なりエラーを throw するため、既存のエラー分岐
 * (isMissingRenameCardPackFunctionError / RENAME_CARD_PACK_VALIDATION_ERRORS /
 * handleDatabaseError)を両経路で共有するにはこの形への詰め替えが必要
 * (gacha.ts GachaRpcDriverError と同じ設計)。
 */
interface RenameCardPackRpcDriverError {
  code?: string;
  message: string;
}

/**
 * rename_card_pack RPC (migration 00063 で新設、00064/00065 でカスケード対象を
 * 拡張。RETURNS void)の pg 直結(postgres.js)実装 (#573)。
 *
 * PostgREST .rpc() は RETURNS void の関数呼び出しで data=null を返す。この route は
 * data を一切参照せず rpcError の有無だけを見るため、pg 経路でも data は常に
 * null に固定してよい。
 *
 * 名前付き引数の理由は gacha.ts executeGachaTransactionRpcPg の doc コメントと
 * 同じ(将来の引数追加・並び替えでの取り違え事故防止)。p_streamer_id は ::uuid
 * キャストで型解決を固定する。p_old_name / p_new_name は TEXT のため、名前付き
 * 引数の関数解決で一意に text へ強制され明示キャスト不要(同 doc コメント参照)。
 *
 * 冪等性判断(plpgsql根拠。migration 00065 が最新定義):
 *   SELECT ordinality - 1 INTO v_old_index
 *   FROM jsonb_array_elements_text(v_catalog) WITH ORDINALITY AS t(name, ordinality)
 *   WHERE t.name = p_old_name LIMIT 1;
 *   IF v_old_index IS NULL THEN RAISE EXCEPTION 'OLD_NAME_NOT_FOUND'; END IF;
 *   ...(カタログのエントリを old→new に書き換え、cards / streamers / rewards /
 *       collection_completions へカスケード)
 * この関数は「カタログ内の1エントリを old_name → new_name へ改名し、他の全
 * テーブルへカスケードする」一度きりの状態遷移であり、「同一値への UPDATE」には
 * 当たらない。1回目の実行が実際にはコミット済みで応答だけが接続断で失われた
 * 場合、同一引数での再実行は上記ガードにヒットする — old_name は既に new_name
 * へ改名済みでカタログに存在しないため OLD_NAME_NOT_FOUND 例外で失敗する。この
 * 例外は下の RENAME_CARD_PACK_VALIDATION_ERRORS により 400(無効なリクエスト)
 * へマッピングされるため、実際には改名が成功しているにもかかわらずユーザーには
 * 失敗したように見えてしまう(「消費・一度きりの状態遷移」に該当)。
 * よって非冪等(既定 = リトライなし)として扱う。
 */
async function renameCardPackRpcPg(
  streamerId: string,
  oldName: string,
  newName: string
): Promise<{ data: null; error: RenameCardPackRpcDriverError | null }> {
  try {
    await withDbRetry(async () => {
      // 規約: getDb() は queryFn の中で呼ぶ(src/lib/db/retry.ts 参照)
      const { sql } = await getDb();
      return sql`
        select rename_card_pack(
          p_streamer_id => ${streamerId}::uuid,
          p_old_name => ${oldName},
          p_new_name => ${newName}
        )
      `;
    }, "rename_card_pack(pg)");
    // 非冪等のため withDbRetry の第3引数(idempotent オプション)は渡さない
    // (既定 false = 接続断でもリトライしない。上記コメント参照)
    return { data: null, error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    // 42883 (undefined_function) = RPC 未デプロイのデプロイ窓。既存の
    // isMissingRenameCardPackFunctionError(rpcError.code === "42883" 判定)を
    // pg 経路でも成立させるため、isPgFunctionNotFoundError で検知を一元化し
    // code を安定して '42883' に正規化する(gacha.ts と同じ判断)。
    if (isPgFunctionNotFoundError(error)) {
      return { data: null, error: { code: "42883", message } };
    }

    const code = (error as { code?: unknown } | null)?.code;
    return {
      data: null,
      error: { code: typeof code === "string" ? code : undefined, message },
    };
  }
}

/**
 * GET /api/cards/collections?streamerId=...
 *
 * Issue #393再設計: 事前登録されたカードパック名一覧を返す(streamers.card_pack_names)。
 * アクティブカードの有無は問わない — パック管理モーダルで定義した時点で選択肢に
 * 含まれる(空パックへの紐付けは保存時に checkCollectionHasActiveCards が別途弾く)。
 *
 * Response: { collections: string[] } (定義順、NULL/重複なし)。
 *
 * 旧実装(DISTINCT な有効カード collection_name を返す)から変更。呼び出し元
 * (ChannelPointSettings)のインターフェースは変更なし。
 */
export async function GET(request: NextRequest) {
  const session = await getSession();
  const { searchParams } = new URL(request.url);
  const streamerId = searchParams.get("streamerId");

  const identifier = await getRateLimitIdentifier(request, session?.twitchUserId);
  const rateLimitResult = await checkRateLimit(rateLimits.cardsGet, identifier);

  if (!rateLimitResult.success) {
    return NextResponse.json<ApiRateLimitResponse>(
      {
        error: ERROR_MESSAGES.RATE_LIMIT_EXCEEDED,
        retryAfter: retryAfterSeconds(rateLimitResult.reset),
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

  if (!session || !canUseStreamerFeatures(session)) {
    return NextResponse.json({ error: ERROR_MESSAGES.UNAUTHORIZED }, { status: 401 });
  }

  if (!streamerId) {
    return NextResponse.json({ error: ERROR_MESSAGES.STREAMER_ID_MISSING }, { status: 400 });
  }

  try {
    const result = await loadOwnedStreamerCatalog(streamerId, session.twitchUserId);
    if (result.error || !result.streamer) {
      return NextResponse.json({ error: ERROR_MESSAGES.FORBIDDEN }, { status: 403 });
    }
    return NextResponse.json({ collections: result.streamer.card_pack_names });
  } catch (error) {
    return handleApiError(error, "Cards Collections API: GET");
  }
}

// Issue #554: RAISE EXCEPTION messages from `rename_card_pack` (see
// supabase/migrations/00063_add_default_pack_name_and_rename.sql) that
// represent a validation failure the API route can confidently map to 400.
// The route already re-validates ownership/format/catalog-membership BEFORE
// calling the RPC, so reaching one of these here means a race occurred
// between that check and the RPC call (e.g. a concurrent catalog edit) —
// still a client-correctable 400, not a server bug. Any OTHER error
// (unexpected message, or none of the above) is treated as a genuine
// server-side failure and surfaces as 500 via handleDatabaseError.
const RENAME_CARD_PACK_VALIDATION_ERRORS = new Set([
  "STREAMER_NOT_FOUND",
  "INVALID_NEW_NAME",
  "RESERVED_NEW_NAME",
  "OLD_NEW_NAME_IDENTICAL",
  "OLD_NAME_NOT_FOUND",
  "NEW_NAME_ALREADY_EXISTS",
]);

/**
 * PATCH /api/cards/collections
 *
 * Issue #554: rename an existing pre-registered pack. Unlike POST
 * /api/streamer/settings (which replaces the whole `card_pack_names` array
 * wholesale), this renames ONE existing entry and cascades the new name to
 * every table that stores a `collection_name` assignment for this streamer
 * (cards, the main channel-point reward, additional rewards) — see the
 * `rename_card_pack` SQL function for the atomic multi-table update.
 *
 * Not plan-gated (unlike registering a brand-new pack name): renaming is a
 * management operation on packs the streamer already owns, mirroring the
 * existing design stance that only NEW registrations are gated (see
 * `isNewCardPackNameAdditionGated` / Issue #269).
 *
 * body: { streamerId: string, oldName: string, newName: string }
 */
export async function PATCH(request: NextRequest) {
  // Content-Type validation must run first (mirrors POST /api/streamer/settings).
  const contentTypeValidation = validateContentType(request, "application/json");
  if (contentTypeValidation) {
    return contentTypeValidation;
  }

  const csrfValidation = await validateCSRFToken(request);
  if (!csrfValidation.valid) {
    return NextResponse.json({ error: ERROR_MESSAGES.FORBIDDEN }, { status: 403 });
  }

  const session = await getSession();

  const identifier = await getRateLimitIdentifier(request, session?.twitchUserId);
  const rateLimitResult = await checkRateLimit(rateLimits.cardsPatch, identifier);

  if (!rateLimitResult.success) {
    return NextResponse.json<ApiRateLimitResponse>(
      {
        error: ERROR_MESSAGES.RATE_LIMIT_EXCEEDED,
        retryAfter: retryAfterSeconds(rateLimitResult.reset),
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

  if (!session || !canUseStreamerFeatures(session)) {
    return NextResponse.json({ error: ERROR_MESSAGES.UNAUTHORIZED }, { status: 401 });
  }

  try {
    const body = await request.json();
    const streamerId = typeof body?.streamerId === "string" ? body.streamerId : null;
    const oldName = typeof body?.oldName === "string" ? body.oldName : null;

    if (!streamerId) {
      return NextResponse.json({ error: ERROR_MESSAGES.STREAMER_ID_MISSING }, { status: 400 });
    }
    if (!oldName) {
      return NextResponse.json({ error: ERROR_MESSAGES.INVALID_REQUEST }, { status: 400 });
    }

    // newName follows the exact same rules as adding a brand-new pack name
    // (validateCardPackNamesInput's per-element checks), shared via
    // validatePackName so both entry points reject identically.
    const newNameValidation = validatePackName(body?.newName);
    if (!newNameValidation.ok) {
      return NextResponse.json({ error: ERROR_MESSAGES.INVALID_REQUEST }, { status: 400 });
    }
    const newName = newNameValidation.value;

    const result = await loadOwnedStreamerCatalog(streamerId, session.twitchUserId);
    if (result.error || !result.streamer) {
      return NextResponse.json({ error: ERROR_MESSAGES.FORBIDDEN }, { status: 403 });
    }
    if (result.cardPackNamesUnavailable) {
      return NextResponse.json({ error: ERROR_MESSAGES.PACK_RENAME_NOT_READY }, { status: 503 });
    }
    const catalog = result.streamer.card_pack_names;

    if (oldName === newName) {
      return NextResponse.json({ error: ERROR_MESSAGES.INVALID_REQUEST }, { status: 400 });
    }
    if (!catalog.includes(oldName)) {
      return NextResponse.json({ error: ERROR_MESSAGES.COLLECTION_NOT_REGISTERED }, { status: 400 });
    }
    if (catalog.includes(newName)) {
      return NextResponse.json({ error: ERROR_MESSAGES.INVALID_REQUEST }, { status: 400 });
    }

    // postgres.js は RPC エラーを throw するため、下流の既存 HTTP エラー契約へ
    // 正規化する renameCardPackRpcPg を必ず使う。実行時フラグで退役済み
    // Supabase 経路へ戻る余地をなくすことが #806 の要件である。
    const { error: rpcError } = await renameCardPackRpcPg(streamerId, oldName, newName);

    if (rpcError) {
      if (isMissingRenameCardPackFunctionError(rpcError)) {
        return NextResponse.json({ error: ERROR_MESSAGES.PACK_RENAME_NOT_READY }, { status: 503 });
      }
      if (RENAME_CARD_PACK_VALIDATION_ERRORS.has(rpcError.message)) {
        return NextResponse.json({ error: ERROR_MESSAGES.INVALID_REQUEST }, { status: 400 });
      }
      return handleDatabaseError(rpcError, "Cards Collections API: PATCH rename_card_pack");
    }

    // Return the full, updated catalog (in original order) so the client can
    // sync local state in one round-trip instead of re-fetching GET.
    const updatedCatalog = catalog.map((name) => (name === oldName ? newName : name));

    return NextResponse.json({ success: true, cardPackNames: updatedCatalog });
  } catch (error) {
    return handleApiError(error, "Cards Collections API: PATCH");
  }
}
