import { getTranslations } from "next-intl/server";

/**
 * Development Notice Banner Component (Server Component)
 * Displays a beta test warning banner
 * 開発通知バナーコンポーネント（サーバーコンポーネント）- ベータテスト警告バナーを表示
 */
export default async function DevelopmentNotice() {
    const t = await getTranslations("developmentNotice");
    return (
        <div className="bg-amber-500 py-2">
            <div className="container mx-auto px-4 text-center">
                <p className="text-sm font-bold text-black">
                    {t("text")}
                </p>
            </div>
        </div>
    );
}
