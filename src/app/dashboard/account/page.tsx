import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getSession } from "@/lib/session";
import { shouldShowVoteCampaign } from "@/lib/storage-db";
import { getUserPlan } from "@/lib/plan";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { LanguageSwitcherSettings } from "@/components/LanguageSwitcher";
import VoteCampaignReshowSetting from "@/components/VoteCampaignReshowSetting";
import SupportPlanSection from "@/components/SupportPlanSection";
import DiscordLinkSection from "@/components/DiscordLinkSection";

// Note: Page is automatically dynamic due to cookies() usage in getSession()
// cookies()使用により自動的に動的ページになるため、force-dynamicは不要

/**
 * Discord連携情報をDBから取得するヘルパー
 * エラー時はnullを返し、呼び出し元のレンダリングをブロックしない
 */
async function getDiscordInfo(twitchUserId: string) {
  try {
    const supabaseAdmin = getSupabaseAdmin();
    const { data } = await supabaseAdmin
      .from("users")
      .select("discord_user_id, discord_has_sub_role")
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
export default async function AccountSettingsPage({
  searchParams,
}: {
  searchParams?: Promise<{ discord_error?: string }>;
}) {
  const t = await getTranslations("accountPage");
  const session = await getSession();

  if (!session) {
    redirect("/");
  }

  const params = await searchParams;
  const discordError = params?.discord_error ?? null;

  // プラン判定・投票キャンペーン判定・Discord情報取得を並列実行
  const [showVoteCampaign, currentPlan, discordInfo] = await Promise.all([
    shouldShowVoteCampaign(session.twitchUserId),
    getUserPlan(session.twitchUserId),
    getDiscordInfo(session.twitchUserId),
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
        {/* 支援プランセクション */}
        <SupportPlanSection currentPlan={currentPlan} />

        {/* Discord連携セクション */}
        <DiscordLinkSection
          discordUserId={discordInfo?.discord_user_id ?? null}
          discordSubVerified={discordInfo?.discord_has_sub_role === true}
          initialError={discordError}
        />

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
      </div>
    </div>
  );
}
