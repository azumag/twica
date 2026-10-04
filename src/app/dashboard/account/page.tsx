import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getSession, canUseStreamerFeatures } from "@/lib/session";
import { getUserPlan } from "@/lib/plan";
import { getTwitchSubRow } from "@/lib/user-data";
import { getStreamerCollectionSettings } from "@/lib/dashboard-data";
import { LanguageSwitcherSettings } from "@/components/LanguageSwitcher";
import SupportPlanSection from "@/components/SupportPlanSection";
import TwitchSubCheckSection from "@/components/TwitchSubCheckSection";
import ChannelPointsAccessSection from "@/components/ChannelPointsAccessSection";
import CardVisibilitySettings from "@/components/CardVisibilitySettings";
import TradeSettings from "@/components/TradeSettings";

// Note: Page is automatically dynamic due to cookies() usage in getSession()
// cookies()使用により自動的に動的ページになるため、force-dynamicは不要

/**
 * Twitchサブスク情報をDBから取得するヘルパー
 * エラー時はnullを返し、呼び出し元のレンダリングをブロックしない
 *
 * users.twitch_has_sub のPlanetScale読み取りはuser-data.tsへ集約する。
 * getTwitchSubRow はクエリエラーを内部でnullへ縮退するため、このtry/catchは
 * getDb()自体の設定不備など、初期化例外に対する最終防御。
 */
async function getTwitchSubInfo(twitchUserId: string) {
  try {
    return await getTwitchSubRow(twitchUserId);
  } catch {
    return null;
  }
}

/**
 * User account settings page
 * ユーザーアカウント設定ページ
 */
export default async function AccountSettingsPage() {
  const t = await getTranslations("accountPage");
  const session = await getSession();

  if (!session) {
    redirect("/");
  }

  // コレクション公開設定・カードトレード設定は配信者向け。POST /api/streamer/settings が
  // 要求する条件(canUseStreamerFeatures)と同じ判定で出し分け、保存できない人には
  // 見せない。配信者行が無い場合(null)や取得失敗時も何も出さず、ページ全体は落とさない。
  const isStreamer = canUseStreamerFeatures(session);

  // プラン判定・Twitchサブスク情報・配信者設定の初期値取得を並列実行
  const [currentPlan, twitchSubInfo, collectionSettings] = await Promise.all([
    getUserPlan(session.twitchUserId),
    getTwitchSubInfo(session.twitchUserId),
    isStreamer ? getStreamerCollectionSettings(session.twitchUserId) : null,
  ]);

  return (
    <div>
      {/* ページヘッダー */}
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-white">{t("title")}</h1>
        <p className="mt-2 text-gray-400">{t("description")}</p>
      </div>

      {/* 設定セクション */}
      <div className="space-y-6">
        {/* 言語設定セクション */}
        <div className="rounded-xl bg-gray-800 p-6">
          <h2 className="mb-4 text-xl font-semibold text-white">
            {t("language.title")}
          </h2>
          <p className="mb-4 text-sm text-gray-400">
            {t("language.description")}
          </p>
          <LanguageSwitcherSettings />
        </div>

        {/* 支援セクション（コード入力） */}
        <SupportPlanSection currentPlan={currentPlan} />

        {/* Twitchサブスク確認セクション */}
        <TwitchSubCheckSection
          initialHasSub={twitchSubInfo?.twitch_has_sub === true}
        />

        {/* Channel Points利用可否確認・非Affiliate向け配信者機能オプトイン (#788) */}
        <ChannelPointsAccessSection
          broadcasterType={session.broadcasterType}
          initialEnabled={session.channelPointsEnabled === true}
        />

        {/* 配信者向け: コレクション公開設定とカードトレード設定 (#715 §6.7)
            配信設定(/dashboard/settings)ではなく視聴者向けコレクション/トレードの
            公開範囲に関わる設定のため、ユーザー設定側に置く。保存は既存の
            POST /api/streamer/settings のまま（トグルは重複させない）。 */}
        {collectionSettings && (
          <section
            aria-labelledby="collection-sharing-heading"
            className="space-y-6"
            data-testid="collection-sharing-section"
          >
            <div>
              <h2
                id="collection-sharing-heading"
                className="text-xl font-semibold text-white"
              >
                {t("collectionSharing.title")}
              </h2>
              <p className="mt-1 text-sm text-gray-400">
                {t("collectionSharing.description")}
              </p>
            </div>
            <CardVisibilitySettings
              streamerId={collectionSettings.streamerId}
              currentShowUnowned={collectionSettings.showUnownedCards}
              currentShowUnownedDetails={collectionSettings.showUnownedCardDetails}
            />
            <TradeSettings
              streamerId={collectionSettings.streamerId}
              currentTradeEnabled={collectionSettings.tradeEnabled}
              currentCrossChannelTradeEnabled={collectionSettings.crossChannelTradeEnabled}
            />
          </section>
        )}
      </div>
    </div>
  );
}
