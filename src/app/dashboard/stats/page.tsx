import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getSession, canUseStreamerFeatures } from "@/lib/session";
import DropRateTable from "@/components/DropRateTable";

/**
 * Gacha Statistics page (streamer only)
 * Shows drop rate comparisons and draw statistics
 * Non-streamers are redirected to dashboard overview
 * ガチャ統計ページ（配信者専用）
 * 排出率比較と排出統計を表示
 * 非配信者はダッシュボード概要にリダイレクト
 */
export default async function GachaStatsPage() {
  const t = await getTranslations("gachaStatsPage");
  const session = await getSession();

  if (!session) {
    return null;
  }

  // Redirect non-streamers to dashboard
  // 非配信者はダッシュボードにリダイレクト
  if (!canUseStreamerFeatures(session)) {
    redirect("/dashboard");
  }

  return (
    <div>
      <h1 className="mb-2 text-2xl font-bold text-white">{t("title")}</h1>
      <p className="mb-6 text-sm text-gray-400">{t("description")}</p>
      <DropRateTable />
    </div>
  );
}
