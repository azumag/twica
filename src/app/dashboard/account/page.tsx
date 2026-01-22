import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getSession } from "@/lib/session";
import { LanguageSwitcherSettings } from "@/components/LanguageSwitcher";

// Note: Page is automatically dynamic due to cookies() usage in getSession()
// cookies()使用により自動的に動的ページになるため、force-dynamicは不要

/**
 * User account settings page
 * Contains language settings and other user preferences
 * ユーザーアカウント設定ページ
 * 言語設定などのユーザー設定を含む
 */
export default async function AccountSettingsPage() {
  const t = await getTranslations("accountPage");
  const session = await getSession();

  // Session check is handled by layout, but double-check for safety
  // セッションチェックはレイアウトで行われるが、安全のため再確認
  if (!session) {
    redirect("/");
  }

  return (
    <div>
      {/* Page header */}
      {/* ページヘッダー */}
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-white">{t("title")}</h1>
        <p className="mt-2 text-gray-400">{t("description")}</p>
      </div>

      {/* Settings sections */}
      {/* 設定セクション */}
      <div className="space-y-6">
        {/* Language Settings Section */}
        {/* 言語設定セクション */}
        <div className="rounded-xl bg-gray-800 p-6">
          <h2 className="mb-4 text-xl font-semibold text-white">
            {t("language.title")}
          </h2>
          <p className="mb-4 text-sm text-gray-400">
            {t("language.description")}
          </p>
          {/* Language switcher component - allows switching between Japanese and English */}
          {/* 言語切り替えコンポーネント - 日本語と英語を切り替え可能 */}
          <LanguageSwitcherSettings />
        </div>
      </div>
    </div>
  );
}
