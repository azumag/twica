import { getTranslations } from "next-intl/server";
import { getSession, canUseStreamerFeatures } from "@/lib/session";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import {
  getGachaHistoryForStreamer,
  getGachaHistoryForUser,
} from "@/lib/dashboard-data";
import GachaHistoryTable from "@/components/GachaHistoryTable";

/**
 * Gacha History page
 * Streamer: shows all channel gacha history with filters
 * Viewer: shows their own gacha history
 * ガチャ履歴ページ
 * 配信者: フィルタ付きのチャンネル全ガチャ履歴
 * 視聴者: 自分のガチャ履歴
 */
export default async function GachaHistoryPage() {
  const t = await getTranslations("gachaHistoryPage");
  const session = await getSession();

  if (!session) {
    return null;
  }

  const isStreamer = canUseStreamerFeatures(session);

  if (isStreamer) {
    // Get streamer_id for the current user
    // 現在のユーザーのstreamer_idを取得
    const supabaseAdmin = getSupabaseAdmin();
    const { data: streamer } = await supabaseAdmin
      .from("streamers")
      .select("id")
      .eq("twitch_user_id", session.twitchUserId)
      .maybeSingle();

    if (!streamer) {
      return null;
    }

    const result = await getGachaHistoryForStreamer(streamer.id);

    return (
      <div>
        <h1 className="mb-6 text-2xl font-bold text-white">{t("title")}</h1>
        <p className="mb-4 text-sm text-gray-400">{t("streamerDescription")}</p>
        <GachaHistoryTable
          initialHistory={result.history}
          initialPagination={result.pagination}
          isStreamer={true}
        />
      </div>
    );
  } else {
    // Viewer: show their own history
    // 視聴者: 自分の履歴を表示
    const result = await getGachaHistoryForUser(session.twitchUserId);

    return (
      <div>
        <h1 className="mb-6 text-2xl font-bold text-white">{t("title")}</h1>
        <p className="mb-4 text-sm text-gray-400">{t("viewerDescription")}</p>
        <GachaHistoryTable
          initialHistory={result.history}
          initialPagination={result.pagination}
          isStreamer={false}
        />
      </div>
    );
  }
}
