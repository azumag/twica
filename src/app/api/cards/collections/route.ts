import { NextRequest, NextResponse } from "next/server";
import { getSession, canUseStreamerFeatures } from "@/lib/session";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { handleApiError, handleDatabaseError } from "@/lib/error-handler";
import { checkRateLimit, rateLimits, getRateLimitIdentifier } from "@/lib/rate-limit";
import { ERROR_MESSAGES } from "@/lib/constants";
import { validateCSRFToken } from "@/lib/csrf";
import { validateContentType } from "@/lib/request-validation";
import {
  isMissingCardPackNamesColumnError,
  isMissingRenameCardPackFunctionError,
} from "@/lib/collections/collection-existence";
import { validatePackName } from "@/lib/validation/collection-name";
import type { ApiRateLimitResponse } from "@/types/api";

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
        retryAfter: (rateLimitResult.reset || 0) - Math.floor(Date.now() / 1000),
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
    const supabaseAdmin = getSupabaseAdmin();

    // Verify the session owns this streamer profile, and read the pre-defined
    // pack list in the same query.
    const { data: streamer, error: streamerError } = await supabaseAdmin
      .from("streamers")
      .select("id, card_pack_names")
      .eq("id", streamerId)
      .eq("twitch_user_id", session.twitchUserId)
      .maybeSingle();

    if (streamerError) {
      // Deploy-window fallback: column not migrated yet → no packs exist.
      if (isMissingCardPackNamesColumnError(streamerError)) {
        const { data: ownedStreamer } = await supabaseAdmin
          .from("streamers")
          .select("id")
          .eq("id", streamerId)
          .eq("twitch_user_id", session.twitchUserId)
          .maybeSingle();
        if (!ownedStreamer) {
          return NextResponse.json({ error: ERROR_MESSAGES.FORBIDDEN }, { status: 403 });
        }
        return NextResponse.json({ collections: [] });
      }
      return NextResponse.json({ error: ERROR_MESSAGES.FORBIDDEN }, { status: 403 });
    }

    if (!streamer) {
      return NextResponse.json({ error: ERROR_MESSAGES.FORBIDDEN }, { status: 403 });
    }

    const collections = Array.isArray(streamer.card_pack_names)
      ? (streamer.card_pack_names as string[])
      : [];

    return NextResponse.json({ collections });
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
        retryAfter: (rateLimitResult.reset || 0) - Math.floor(Date.now() / 1000),
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

    const supabaseAdmin = getSupabaseAdmin();

    // Ownership check + current catalog snapshot, so we can validate
    // membership/duplication with a normal 400 BEFORE ever calling the RPC
    // (the RPC re-validates too, but only as defense-in-depth against races —
    // see RENAME_CARD_PACK_VALIDATION_ERRORS above).
    const { data: streamer, error: streamerError } = await supabaseAdmin
      .from("streamers")
      .select("id, card_pack_names")
      .eq("id", streamerId)
      .eq("twitch_user_id", session.twitchUserId)
      .maybeSingle();

    if (streamerError) {
      // Deploy-window fallback: the card_pack_names column (and therefore any
      // pack the streamer could rename) isn't migrated yet.
      if (isMissingCardPackNamesColumnError(streamerError)) {
        return NextResponse.json({ error: ERROR_MESSAGES.PACK_RENAME_NOT_READY }, { status: 503 });
      }
      return NextResponse.json({ error: ERROR_MESSAGES.FORBIDDEN }, { status: 403 });
    }

    if (!streamer) {
      return NextResponse.json({ error: ERROR_MESSAGES.FORBIDDEN }, { status: 403 });
    }

    const catalog: string[] = Array.isArray(streamer.card_pack_names)
      ? (streamer.card_pack_names as string[])
      : [];

    if (oldName === newName) {
      return NextResponse.json({ error: ERROR_MESSAGES.INVALID_REQUEST }, { status: 400 });
    }
    if (!catalog.includes(oldName)) {
      return NextResponse.json({ error: ERROR_MESSAGES.COLLECTION_NOT_REGISTERED }, { status: 400 });
    }
    if (catalog.includes(newName)) {
      return NextResponse.json({ error: ERROR_MESSAGES.INVALID_REQUEST }, { status: 400 });
    }

    const { error: rpcError } = await supabaseAdmin.rpc("rename_card_pack", {
      p_streamer_id: streamerId,
      p_old_name: oldName,
      p_new_name: newName,
    });

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
