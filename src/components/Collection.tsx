import Image from "next/image";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import type { Streamer, Card } from "@/types/database";
import { CARD_TRADE_UI_VISIBLE } from "@/lib/constants";
import {
  DEFAULT_STREAMER_COLLECTION_SORT,
  type StreamerCollectionSortMode,
} from "@/lib/collection-utils";
import CollectionHideButton from "@/components/CollectionHideButton";

interface CardWithDetails extends Card {
  streamer: Streamer;
  count: number;
}

/**
 * Calculate rarity statistics for a set of cards
 * カードセットのレアリティ別統計を計算
 */
const calculateStreamerStats = (cards: CardWithDetails[]) => ({
  total: cards.reduce((sum, c) => sum + c.count, 0),
  unique: cards.length,
  legendary: cards.filter((c) => c.rarity === "legendary").length,
  epic: cards.filter((c) => c.rarity === "epic").length,
  rare: cards.filter((c) => c.rarity === "rare").length,
  common: cards.filter((c) => c.rarity === "common").length,
});

interface StreamerCollectionEntry {
  streamer: Streamer;
  cards: CardWithDetails[];
  totalActive: number;
  ownedActive: number;
  isComplete?: boolean;
}

interface CollectionProps {
  /**
   * 通常一覧に表示する配信者（並び替え済み。Object.values の順で表示する）。
   * キーは UUID（配列インデックスに解釈される整数文字列ではない）なので
   * 挿入順が保たれる。並び替えは呼び出し側（page.tsx）の sortStreamerCollections で行う。
   */
  cardsByStreamer: Record<string, StreamerCollectionEntry>;
  /** 視聴者が非表示にした配信者（#1953）。一覧の下の折りたたみ内に表示する。 */
  hiddenCardsByStreamer?: Record<string, StreamerCollectionEntry>;
  /** 現在の並び替えモード（切替リンクの強調表示用。並びそのものは cardsByStreamer 側で確定済み）。 */
  sortMode?: StreamerCollectionSortMode;
}

/** 並び替えモード切替リンク。既定(recent)は URL を汚さないようクエリ無しにする。 */
const SORT_OPTIONS: ReadonlyArray<{ mode: StreamerCollectionSortMode; href: string }> = [
  { mode: "recent", href: "/dashboard/collection" },
  { mode: "name", href: "/dashboard/collection?sort=name" },
  { mode: "completion", href: "/dashboard/collection?sort=completion" },
];

/**
 * Collection Component (Server Component)
 * Displays summary of user's card collection by streamer
 * コレクションコンポーネント（サーバーコンポーネント）- 配信者ごとのコレクションサマリを表示
 */
export default async function Collection({
  cardsByStreamer,
  hiddenCardsByStreamer = {},
  sortMode = DEFAULT_STREAMER_COLLECTION_SORT,
}: CollectionProps) {
  const t = await getTranslations("collection");
  const tStats = await getTranslations("stats");
  const tCollectionPage = await getTranslations("collectionPage");
  const tTrade = await getTranslations("trade");

  const visibleEntries = Object.values(cardsByStreamer);
  const hiddenEntries = Object.values(hiddenCardsByStreamer);

  /**
   * 配信者1件分のカード。通常一覧と「非表示のコレクション」で同じ見た目を使い、
   * 違いは操作ボタン（非表示 / 再表示）だけにする。
   * hidden = true のとき「再表示」ボタンを出す。
   */
  const renderStreamerCard = (
    { streamer, cards, totalActive, ownedActive, isComplete }: StreamerCollectionEntry,
    hidden: boolean,
  ) => {
    // Calculate rarity statistics for each streamer
    // 各配信者のレアリティ別統計を計算
    const streamerStats = calculateStreamerStats(cards);
    const streamerCompletionPercent = totalActive > 0 ? Math.round((ownedActive / totalActive) * 100) : 0;
    const safeStreamerCompletionPercent = Math.max(0, Math.min(100, streamerCompletionPercent));
    return (
      <div
        key={streamer.id}
        className="rounded-xl bg-gray-800 p-4 hover:bg-gray-700 transition-colors"
      >
        {/* Streamer Header - 配信者ヘッダー */}
        <div className="flex items-center gap-3 mb-4">
          {streamer.twitch_profile_image_url && (
            // unoptimized: Twitch CDNから取得済みの画像のため、Vercel Image Transformationsをスキップしてコスト削減
            <Image
              src={streamer.twitch_profile_image_url}
              alt={streamer.twitch_display_name}
              width={48}
              height={48}
              className="h-12 w-12 rounded-full"
              unoptimized
            />
          )}
          <div className="flex-1 min-w-0">
            <h3 className="flex items-center gap-1 min-w-0 font-semibold text-white">
              <span className="truncate">{streamer.twitch_display_name}</span>
              {/* 勲章アイコン: ゴールド=現在コンプリート */}
              {isComplete && (
                <svg className="w-4 h-4 shrink-0 text-yellow-400" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <path d="M8 2l2 4h4l2-4H8z" opacity="0.7" />
                  <circle cx="12" cy="14" r="7" />
                  <path d="M12 9l1.5 3 3.5.5-2.5 2.5.5 3.5L12 16.5 9 18.5l.5-3.5L7 12.5l3.5-.5z" fill="white" opacity="0.3" />
                </svg>
              )}
            </h3>
            <p className="text-sm text-gray-400">
              {tCollectionPage("streamerOwnedCards", {
                total: streamerStats.total,
              })}
            </p>
            <p className="text-xs text-gray-500">
              {tCollectionPage("streamerCompletionProgress", {
                owned: ownedActive,
                total: totalActive,
              })}
            </p>
            <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-gray-700">
              <div
                className="h-full rounded-full bg-emerald-500/90 transition-all"
                style={{ width: `${safeStreamerCompletionPercent}%` }}
                aria-label={tCollectionPage("progressAria", { percent: safeStreamerCompletionPercent })}
              />
            </div>
          </div>
        </div>

        {/* Rarity Summary - レアリティサマリ */}
        <div className="grid grid-cols-4 gap-2 mb-4">
          {/* Legendary */}
          {streamerStats.legendary > 0 && (
            <div className="rounded-lg bg-yellow-500/20 px-2 py-1 text-center">
              <div className="text-sm font-bold text-yellow-400">{streamerStats.legendary}</div>
              <div className="text-xs text-yellow-400/80">{tStats("legendary")}</div>
            </div>
          )}
          {/* Epic */}
          {streamerStats.epic > 0 && (
            <div className="rounded-lg bg-purple-500/20 px-2 py-1 text-center">
              <div className="text-sm font-bold text-purple-400">{streamerStats.epic}</div>
              <div className="text-xs text-purple-400/80">{tStats("epic")}</div>
            </div>
          )}
          {/* Rare */}
          {streamerStats.rare > 0 && (
            <div className="rounded-lg bg-blue-500/20 px-2 py-1 text-center">
              <div className="text-sm font-bold text-blue-400">{streamerStats.rare}</div>
              <div className="text-xs text-blue-400/80">{tStats("rare")}</div>
            </div>
          )}
          {/* Common */}
          {streamerStats.common > 0 && (
            <div className="rounded-lg bg-gray-600/50 px-2 py-1 text-center">
              <div className="text-sm font-bold text-gray-300">{streamerStats.common}</div>
              <div className="text-xs text-gray-400">{tStats("common")}</div>
            </div>
          )}
        </div>

        {/* View Collection Button - コレクション表示ボタン
          非表示中でも直リンクは生きている（非表示は一覧の見せ方だけの設定）ため、
          「コレクションを見る」は両方のセクションに出す。 */}
        <div className="flex items-start gap-2">
          <Link
            href={`/collection/${streamer.id}`}
            className="block flex-1 rounded-lg bg-purple-600 hover:bg-purple-700 px-4 py-2 text-center text-sm font-medium text-white transition-colors"
          >
            {t("viewCollection")}
          </Link>
          <CollectionHideButton
            streamerId={streamer.id}
            streamerName={streamer.twitch_display_name}
            hide={!hidden}
          />
        </div>
      </div>
    );
  };

  return (
    <section>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-2xl font-semibold text-white">{t("title")}</h2>
        {/* #727: permanent entry point to /trade/mine. Trade completion has no
            notifications in the MVP, so users must be able to reach their
            listings without going back through a streamer's board.
            #715: while the trade feature is not public yet
            (CARD_TRADE_UI_VISIBLE=false, taken from main #1803/#1805), this
            entry is hidden together with the streamer-collection "Trade" button
            and the trade settings, so no trade entry point shows on its own.
            /trade/mine itself stays reachable by direct link. */}
        {CARD_TRADE_UI_VISIBLE && (
          <Link
            href="/trade/mine"
            className="rounded-lg bg-gray-800 px-4 py-2 text-sm text-purple-300 transition-colors hover:bg-gray-700 hover:text-purple-200"
          >
            {tTrade("myTradesLink")}
          </Link>
        )}
      </div>

      {/* Streamer List with Summary - 配信者一覧とサマリ */}
      {visibleEntries.length === 0 && hiddenEntries.length === 0 ? (
        <div className="rounded-xl bg-gray-800 p-8 text-center">
          <p className="text-gray-400">
            {t("empty.line1")}
            <br />
            {t("empty.line2")}
          </p>
        </div>
      ) : (
        <>
          {/* #1953: 並び替え。URL クエリ ?sort= を切り替える Link にして、サーバーコンポーネントのまま
              実現する（client 化せず、並び順を共有・ブックマークできる）。
              1件以下では並び替える意味が無いので出さない。 */}
          {visibleEntries.length > 1 && (
            <div className="mb-4 flex flex-wrap items-center gap-2">
              <span className="text-sm text-gray-400">{t("sort.label")}</span>
              {SORT_OPTIONS.map(({ mode, href }) => (
                <Link
                  key={mode}
                  href={href}
                  scroll={false}
                  aria-current={sortMode === mode ? "true" : undefined}
                  className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                    sortMode === mode
                      ? "bg-purple-600 text-white"
                      : "border border-gray-600 text-gray-300 hover:bg-gray-700"
                  }`}
                >
                  {t(`sort.${mode}`)}
                </Link>
              ))}
            </div>
          )}

          {visibleEntries.length === 0 ? (
            // 全件を非表示にした状態。「カードが無い」空状態とは別の文言にして、
            // 下の「非表示のコレクション」から戻せることが分かるようにする。
            <div className="rounded-xl bg-gray-800 p-8 text-center">
              <p className="text-gray-400">{t("hidden.allHidden")}</p>
            </div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {visibleEntries.map((entry) => renderStreamerCard(entry, false))}
            </div>
          )}

          {/* #1953: 非表示のコレクション。既定は折りたたみで、<details> なので
              JS 無しでも開閉でき、サーバーコンポーネントのまま実現できる。 */}
          {hiddenEntries.length > 0 && (
            <details className="mt-8 rounded-xl border border-gray-700 p-4">
              <summary className="cursor-pointer text-sm font-medium text-gray-300">
                {t("hidden.summary", { count: hiddenEntries.length })}
              </summary>
              <p className="mt-2 mb-4 text-xs text-gray-500">{t("hidden.description")}</p>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {hiddenEntries.map((entry) => renderStreamerCard(entry, true))}
              </div>
            </details>
          )}
        </>
      )}
    </section>
  );
}
