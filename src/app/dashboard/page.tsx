import Link from "next/link";
import Image from "next/image";
import { getTranslations } from "next-intl/server";
import { getSession, canUseStreamerFeatures } from "@/lib/session";
import { getUserCards } from "@/lib/dashboard-data";
import { RARITY_ORDER, RARITIES } from "@/lib/constants";
import Stats from "@/components/Stats";
// Streamer type is used by getUserCards internally but not needed in this file
// Streamer型はgetUserCards内部で使用されるが、このファイルでは不要

// Note: Page is automatically dynamic due to cookies() usage in getSession()
// cookies()使用により自動的に動的ページになるため、force-dynamicは不要

/**
 * Dashboard overview page
 * Shows summary statistics, recent cards, and quick links to other sections
 * ダッシュボード概要ページ
 * 統計概要、最近のカード、他のセクションへのクイックリンクを表示
 */
export default async function DashboardPage() {
  const t = await getTranslations("dashboard");
  const tCards = await getTranslations("cardsPage");
  const tSettings = await getTranslations("settingsPage");
  const tCollection = await getTranslations("collectionPage");
  const session = await getSession();

  // Session check is handled by layout, but we need session for data fetch
  // セッションチェックはレイアウトで行われるが、データ取得にセッションが必要
  if (!session) {
    return null;
  }

  const isStreamer = canUseStreamerFeatures(session);

  // Fetch user's card collection
  // ユーザーのカードコレクションを取得（streamerDataは概要ページでは不要）
  const userCards = await getUserCards(session.twitchUserId);

  // Sort cards by rarity (legendary first)
  // レアリティでソート（レジェンダリーが先頭）
  userCards.sort((a, b) => {
    return RARITY_ORDER.indexOf(a.rarity) - RARITY_ORDER.indexOf(b.rarity);
  });

  // Calculate collection statistics
  // コレクション統計を計算
  const stats = {
    total: userCards.reduce((sum, c) => sum + c.count, 0),
    unique: userCards.length,
    legendary: userCards.filter((c) => c.rarity === "legendary").length,
    epic: userCards.filter((c) => c.rarity === "epic").length,
    rare: userCards.filter((c) => c.rarity === "rare").length,
    common: userCards.filter((c) => c.rarity === "common").length,
  };

  // Get recent cards for preview (max 4)
  // プレビュー用の最近のカード（最大4枚）
  const recentCards = userCards.slice(0, 4);

  /**
   * Get rarity information (label and color) for display
   * 表示用のレアリティ情報（ラベルと色）を取得
   */
  const getRarityInfo = (rarity: string) =>
    RARITIES.find((r) => r.value === rarity) || RARITIES[0];

  return (
    <div>
      {/* Non-streamer info */}
      {/* 非配信者向け情報 */}
      {!isStreamer && (
        <div className="mb-8 rounded-xl bg-gray-800 p-6">
          <h2 className="mb-2 text-lg font-semibold text-white">
            {t("overview.streamerInfo")}
          </h2>
          <p className="text-gray-400">
            {t("overview.streamerInfoText")}
          </p>
        </div>
      )}

      {/* Collection summary section */}
      {/* コレクション概要セクション */}
      <section className="mb-8">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-xl font-semibold text-white">
            {t("overview.collectionSummary")}
          </h2>
          <Link
            href="/dashboard/collection"
            className="text-sm text-purple-400 hover:text-purple-300"
          >
            {t("overview.viewAllCollection")} →
          </Link>
        </div>

        {/* Statistics */}
        {/* 統計情報 */}
        <Stats stats={stats} />

        {/* Recent collection cards preview */}
        {/* 最近のコレクションカードプレビュー */}
        {recentCards.length > 0 && (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {recentCards.map((card, index) => {
              const rarityInfo = getRarityInfo(card.rarity);
              // First 4 cards get priority for LCP optimization
              // 最初の4枚のカードはLCP最適化のためpriority設定
              const isPriority = index < 4;
              return (
                <div
                  key={card.id}
                  className="overflow-hidden rounded-lg bg-gray-800"
                >
                  <div className="aspect-square bg-gray-700">
                    {card.image_url ? (
                      <Image
                        src={card.image_url}
                        alt={card.name}
                        width={200}
                        height={200}
                        className="h-full w-full object-cover"
                        priority={isPriority}
                      />
                    ) : (
                      <div className="flex h-full items-center justify-center text-4xl text-gray-600">
                        🎴
                      </div>
                    )}
                  </div>
                  <div className="p-3">
                    <div className="flex items-center justify-between">
                      <h3 className="truncate font-medium text-white">
                        {card.name}
                      </h3>
                      <span
                        className={`shrink-0 rounded-full px-2 py-0.5 text-xs text-white ${rarityInfo.color}`}
                      >
                        {rarityInfo.label}
                      </span>
                    </div>
                    {card.count > 1 && (
                      <p className="mt-1 text-xs text-gray-400">
                        x{card.count}
                      </p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Quick links section (for streamers) */}
      {/* クイックリンクセクション（配信者向け） */}
      {isStreamer && (
        <section>
          <h2 className="mb-4 text-xl font-semibold text-white">
            {t("overview.quickLinks")}
          </h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {/* Card management link */}
            {/* カード管理リンク */}
            <Link
              href="/dashboard/cards"
              className="group rounded-xl bg-gray-800 p-6 transition-colors hover:bg-gray-700"
            >
              <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-lg bg-purple-600/20">
                <svg
                  className="h-6 w-6 text-purple-400"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"
                  />
                </svg>
              </div>
              <h3 className="font-semibold text-white group-hover:text-purple-400">
                {tCards("title")}
              </h3>
              <p className="mt-1 text-sm text-gray-400">
                {tCards("description")}
              </p>
            </Link>

            {/* Settings link */}
            {/* 設定リンク */}
            <Link
              href="/dashboard/settings"
              className="group rounded-xl bg-gray-800 p-6 transition-colors hover:bg-gray-700"
            >
              <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-lg bg-blue-600/20">
                <svg
                  className="h-6 w-6 text-blue-400"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
                  />
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
                  />
                </svg>
              </div>
              <h3 className="font-semibold text-white group-hover:text-blue-400">
                {tSettings("title")}
              </h3>
              <p className="mt-1 text-sm text-gray-400">
                {tSettings("description")}
              </p>
            </Link>

            {/* Collection link */}
            {/* コレクションリンク */}
            <Link
              href="/dashboard/collection"
              className="group rounded-xl bg-gray-800 p-6 transition-colors hover:bg-gray-700"
            >
              <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-lg bg-green-600/20">
                <svg
                  className="h-6 w-6 text-green-400"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4"
                  />
                </svg>
              </div>
              <h3 className="font-semibold text-white group-hover:text-green-400">
                {tCollection("title")}
              </h3>
              <p className="mt-1 text-sm text-gray-400">
                {tCollection("description")}
              </p>
            </Link>
          </div>
        </section>
      )}
    </div>
  );
}
