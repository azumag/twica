import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getSession } from "@/lib/session";
import { shouldShowVoteCampaign } from "@/lib/storage-db";
import { getUserPlan } from "@/lib/plan";
import { getTwitchSubRow } from "@/lib/user-data";
import { LanguageSwitcherSettings } from "@/components/LanguageSwitcher";
import VoteCampaignReshowSetting from "@/components/VoteCampaignReshowSetting";
import SupportPlanSection from "@/components/SupportPlanSection";
import TwitchSubCheckSection from "@/components/TwitchSubCheckSection";
import ChannelPointsAccessSection from "@/components/ChannelPointsAccessSection";

// Note: Page is automatically dynamic due to cookies() usage in getSession()
// cookies()使用により自動的に動的ページになるため、force-dynamicは不要

/**
 * Twitchサブスク情報をDBから取得するヘルパー
 * エラー時はnullを返し、呼び出し元のレンダリングをブロックしない
 *
 * #711: users.twitch_has_sub の読み取りは user-data.ts の getTwitchSubRow に
 * 委譲（isPgReadEnabled() による経路分岐は関数内部で行われるため、このページは
 * フラグを意識しない）。getTwitchSubRow は pg 経路のクエリエラーも内部で
 * 握りつぶして null を返す設計のため、この try/catch は主に
 * getSupabaseAdmin()/getDb() 自体が投げる例外（設定不備等）に対する保険。
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

  // プラン判定・投票キャンペーン判定・Twitchサブスク情報取得を並列実行
  const [showVoteCampaign, currentPlan, twitchSubInfo] = await Promise.all([
    shouldShowVoteCampaign(session.twitchUserId),
    getUserPlan(session.twitchUserId),
    getTwitchSubInfo(session.twitchUserId),
  ]);

  return (
    <div>
      {/* ページヘッダー */}
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-white">{t("title")}</h1>
        <p className="mt-2 text-gray-400">{t("description")}</p>
      </div>

      {/* キャンペーンパネル再表示設定（非表示設定済みかつ未適用の場合のみ表示） */}
      <VoteCampaignReshowSetting visible={showVoteCampaign} />

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
      </div>
    </div>
  );
}
