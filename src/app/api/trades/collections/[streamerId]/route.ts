import { type NextRequest, NextResponse } from "next/server";

import { getSession } from "@/lib/session";
import { parseTradeCollectionSort, type TradeCollectionKind } from "@/lib/trade";
import { listTradeCollectionPage } from "@/lib/trade-collections";
import {
  limitTradeRead,
  parseTradePage,
  tradeAuctionErrorResponse,
  tradeErrorResponse,
  tradeInternalErrorResponse,
} from "@/lib/trade-api";
import { TradeAuctionUnavailableError } from "@/lib/trade-auction";
import { normalizeCanonicalUuid } from "@/lib/uuid-validation";

/**
 * GET /api/trades/collections/[streamerId]?kind=offer|auction&sort=&page=N
 *
 * ハブ /trade のコレクション別一覧の「展開」用 (#2079)。折りたたみ時は
 * 先頭5件しか返さないため、6件目以降はこのエンドポイントで取得する。
 *
 * - ログイン必須（未ログインは 401）。閲覧者自身の所持コレクションしか
 *   読めないため、公開ボードの GET /api/trades とは認証要件が異なる。
 * - レート制限は既存の一覧と同じ tradeRead バケット。
 * - 閲覧者がそのコレクションを持っていない場合は 404
 *   (TRADE_COLLECTION_NOT_FOUND)。403 にすると「存在するが持っていない」
 *   ことを確認できてしまうため、既存の「隠れた行と存在しない行は同じ 404」
 *   という流儀に合わせる。
 * - 並び順は allowlist で検証し、不明な値は既定 (newest) に落とす。
 *   kind は列挙なので不明なら 400。
 * - 折りたたみ時と同じ listTradeCollectionPage を配信者1件・
 *   TRADE_PAGE_SIZE 件で呼ぶため、先頭5件と展開後で条件・並び・DTO が
 *   ずれない。
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ streamerId: string }> },
) {
  const session = await getSession();
  if (!session) {
    return tradeErrorResponse("UNAUTHORIZED", 401);
  }

  const limited = await limitTradeRead(request, session.twitchUserId);
  if (limited) return limited;

  // #2061: normalize the path UUID to the lowercase form returned by the DB.
  const { streamerId: rawStreamerId } = await params;
  const streamerId = normalizeCanonicalUuid(rawStreamerId);
  if (!streamerId) {
    return tradeErrorResponse("INVALID_REQUEST", 400);
  }

  const { searchParams } = request.nextUrl;
  const rawKind = searchParams.get("kind");
  if (rawKind !== "offer" && rawKind !== "auction") {
    return tradeErrorResponse("INVALID_REQUEST", 400);
  }
  const kind: TradeCollectionKind = rawKind;
  const sort = parseTradeCollectionSort(searchParams.get("sort") ?? undefined);
  const page = parseTradePage(searchParams.get("page"));
  if (page === null) {
    return tradeErrorResponse("INVALID_REQUEST", 400);
  }

  try {
    const result = await listTradeCollectionPage({
      twitchUserId: session.twitchUserId,
      streamerId,
      kind,
      sort,
      page,
    });
    if (!result) {
      return tradeErrorResponse("TRADE_COLLECTION_NOT_FOUND", 404);
    }
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof TradeAuctionUnavailableError) {
      return tradeAuctionErrorResponse("TRADE_AUCTION_UNAVAILABLE");
    }
    return tradeInternalErrorResponse(error, "Trade collection page");
  }
}
