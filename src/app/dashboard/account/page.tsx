import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getSession } from "@/lib/session";
import { shouldShowVoteCampaign } from "@/lib/storage-db";
import { getUserPlan } from "@/lib/plan";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { LanguageSwitcherSettings } from "@/components/LanguageSwitcher";
import VoteCampaignReshowSetting from "@/components/VoteCampaignReshowSetting";
import SupportPlanSection from "@/components/SupportPlanSection";
import TwitchSubCheckSection from "@/components/TwitchSubCheckSection";

// Note: Page is automatically dynamic due to cookies() usage in getSession()
// cookies()使用により自動的に動的ページになるため、force-dynamicは不要

/**
 * Twitchサブスク情報をDBから取得するヘルパー
 * エラー時はnullを返し、呼び出し元のレンダリングをブロックしない
 */
async function getTwitchSubInfo(twitchUserId: string) {
  try {
    const supabaseAdmin = getSupabaseAdmin();
    const { data } = await supabaseAdmin
      .from("users")
      .select("twitch_has_sub")
      .eq("twitch_user_id", twitchUserId)
      .maybeSingle();
    return data;
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
      </div>
    </div>
  );
}
