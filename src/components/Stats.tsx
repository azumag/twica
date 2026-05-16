import { getTranslations } from "next-intl/server";
import { getRarityDisplayInfo } from "@/lib/rarity";

interface StatsProps {
  stats: {
    total: number;
    unique: number;
    legendary: number;
    epic: number;
    rare: number;
    common: number;
    // カスタムレアリティ別の所持ユニーク数（デフォルト4種以外）。
    // 後方互換のため未指定（undefined）も許容する。
    customRarities?: { rarity: string; count: number }[];
  };
}

/**
 * Stats Display Component (Server Component)
 * Shows card collection statistics by rarity
 * 統計表示コンポーネント（サーバーコンポーネント）- レアリティ別のカードコレクション統計を表示
 */
export default async function Stats({ stats }: StatsProps) {
  const t = await getTranslations("stats");
  return (
    <div className="mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-6">
      <div className="rounded-xl bg-gray-800 p-4 text-center">
        <div className="text-3xl font-bold text-white">{stats.total}</div>
        <div className="text-sm text-gray-400">{t("totalCards")}</div>
      </div>
      <div className="rounded-xl bg-gray-800 p-4 text-center">
        <div className="text-3xl font-bold text-white">{stats.unique}</div>
        <div className="text-sm text-gray-400">{t("unique")}</div>
      </div>
      <div className="rounded-xl bg-yellow-500/20 p-4 text-center">
        <div className="text-3xl font-bold text-yellow-400">
          {stats.legendary}
        </div>
        <div className="text-sm text-yellow-400/70">{t("legendary")}</div>
      </div>
      <div className="rounded-xl bg-purple-500/20 p-4 text-center">
        <div className="text-3xl font-bold text-purple-400">
          {stats.epic}
        </div>
        <div className="text-sm text-purple-400/70">{t("epic")}</div>
      </div>
      <div className="rounded-xl bg-blue-500/20 p-4 text-center">
        <div className="text-3xl font-bold text-blue-400">{stats.rare}</div>
        <div className="text-sm text-blue-400/70">{t("rare")}</div>
      </div>
      <div className="rounded-xl bg-gray-500/20 p-4 text-center">
        <div className="text-3xl font-bold text-gray-400">
          {stats.common}
        </div>
        <div className="text-sm text-gray-400/70">{t("common")}</div>
      </div>
      {/* カスタムレアリティ別の内訳（デフォルト4種の後ろに追加表示）。
          色は固定レアリティ用の色定義が無いため共通フォールバックを使う。 */}
      {(stats.customRarities ?? []).map(({ rarity, count }) => {
        const info = getRarityDisplayInfo(rarity);
        return (
          <div
            key={rarity}
            className="rounded-xl bg-gray-800 p-4 text-center"
          >
            <div className="text-3xl font-bold text-white">{count}</div>
            <div className="mt-1 flex justify-center">
              <span
                className={`inline-block rounded-full px-2 py-0.5 text-xs text-white ${info.color}`}
              >
                {info.label}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
