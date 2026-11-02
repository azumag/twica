import Image from "next/image";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import type { Streamer, Card } from "@/types/database";
import {
  DEFAULT_STREAMER_COLLECTION_SORT,
  type StreamerCollectionSortMode,
} from "@/lib/collection-utils";
import CollectionStreamerList from "@/components/CollectionStreamerList";

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
   * 全配信者（非表示を含む）。キーは配信者ID。ここでの順序には意味が無く、表示順は orders で決まる。
   * 非表示かどうかも client 側の状態で決まる（hiddenStreamerIds は初期値）。
   */
  cardsByStreamer: Record<string, StreamerCollectionEntry>;
  /**
   * 並び替えモードごとの配信者ID配列（page.tsx が sortStreamerCollections で確定させたもの）。
   * 比較ロジックを client に複製しないため、順序はサーバーで確定させ ID だけを渡す。
   */
  orders?: Record<StreamerCollectionSortMode, string[]>;
  /** 視聴者が非表示にした配信者ID（#1953。初期値。以降の増減は client 側で楽観的に反映する）。 */
  hiddenStreamerIds?: string[];
  /** 初期の並び替えモード（URL の ?sort= をサーバーで解釈したもの）。 */
  sortMode?: StreamerCollectionSortMode;
}

/** orders 未指定（カード0枚の呼び出しなど）のときの空の並び。 */
const EMPTY_ORDERS: Record<StreamerCollectionSortMode, string[]> = {
  recent: [],
  name: [],
  completion: [],
};

/**
 * Collection Component (Server Component)
 * Displays summary of user's card collection by streamer
 * コレクションコンポーネント（サーバーコンポーネント）- 配信者ごとのコレクションサマリを表示
 *
 * #1953: 各カードの中身（ヘッダー・レアリティサマリ・リンク）はここでサーバー描画し、
 * 並び替え・非表示の切替は client component の CollectionStreamerList に任せる。
 * 以前は並び替え(?sort= の Link 遷移)も非表示(POST 後の router.refresh())も、操作のたびに
 * サーバーで画面全体を作り直しており、米国 colo → DB(ソウル) の往復も重なって
 * 本番実測で 2.2〜2.8 秒かかっていたため（Refs #1953）。
 */
export default async function Collection({
  cardsByStreamer,
  orders = EMPTY_ORDERS,
  hiddenStreamerIds = [],
  sortMode = DEFAULT_STREAMER_COLLECTION_SORT,
}: CollectionProps) {
  const t = await getTranslations("collection");
  const tStats = await getTranslations("stats");
  const tCollectionPage = await getTranslations("collectionPage");

  const entries = Object.values(cardsByStreamer);

  /**
   * 配信者1件分のカードの中身（ヘッダーとレアリティサマリ、「コレクションを見る」リンク）。
   * カード外枠・リンクと非表示ボタンを並べる行・非表示ボタンは、非表示/再表示で
   * カードが移動するため client 側（CollectionStreamerList）で描画する。
   */
  const renderStreamerItem = ({
    streamer,
    cards,
    totalActive,
    ownedActive,
    isComplete,
  }: StreamerCollectionEntry) => {
    // Calculate rarity statistics for each streamer
    // 各配信者のレアリティ別統計を計算
    const streamerStats = calculateStreamerStats(cards);
    const streamerCompletionPercent = totalActive > 0 ? Math.round((ownedActive / totalActive) * 100) : 0;
    const safeStreamerCompletionPercent = Math.max(0, Math.min(100, streamerCompletionPercent));
    const body = (
      <>
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

      </>
    );

    // 「コレクションを見る」は非表示中でも直リンクが生きている（非表示は一覧の見せ方だけの設定）
    // ため、通常一覧・非表示セクションの両方に出す。
    const viewLink = (
      <Link
        href={`/collection/${streamer.id}`}
        className="block flex-1 rounded-lg bg-purple-600 hover:bg-purple-700 px-4 py-2 text-center text-sm font-medium text-white transition-colors"
      >
        {t("viewCollection")}
      </Link>
    );

    return {
      id: streamer.id,
      body,
      viewLink,
      streamerName: streamer.twitch_display_name,
    };
  };

  return (
    <section>
      <h2 className="mb-6 text-2xl font-semibold text-white">{t("title")}</h2>

      {/* Streamer List with Summary - 配信者一覧とサマリ */}
      {entries.length === 0 ? (
        <div className="rounded-xl bg-gray-800 p-8 text-center">
          <p className="text-gray-400">
            {t("empty.line1")}
            <br />
            {t("empty.line2")}
          </p>
        </div>
      ) : (
        // #1953: 並び替え・非表示セクション・全件非表示の文言は client 側の状態で決まるため、
        // CollectionStreamerList が描画する（表示順はサーバー確定の orders に従う）。
        <CollectionStreamerList
          items={entries.map(renderStreamerItem)}
          orders={orders}
          initialSort={sortMode}
          initialHiddenIds={hiddenStreamerIds}
        />
      )}
    </section>
  );
}
