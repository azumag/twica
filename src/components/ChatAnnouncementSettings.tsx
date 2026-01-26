"use client";

import { useState, useCallback, useEffect } from "react";
import { useTranslations } from "next-intl";
import { logger } from "@/lib/logger";

interface ChatAnnouncementSettingsProps {
  streamerId: string;
  // チャット通知の有効/無効状態
  // Whether chat announcement is enabled
  currentEnabled: boolean;
  // カスタムテンプレート（nullの場合はデフォルト）
  // Custom template (null for default)
  currentTemplate: string | null;
}

/**
 * CookieからCSRFトークンを取得するヘルパー関数
 * CSRF保護のためにすべてのAPI呼び出しで使用
 */
function getCsrfTokenFromCookie(): string {
  if (typeof document === "undefined") return "";
  return document.cookie
    .split("; ")
    .find(row => row.startsWith("csrf_token="))
    ?.split("=")[1] || "";
}

/**
 * チャット通知設定コンポーネント
 * ガチャ結果をTwitchチャットに通知する機能の設定UI
 * Settings component for Twitch chat announcements of gacha results
 */
export default function ChatAnnouncementSettings({
  streamerId,
  currentEnabled,
  currentTemplate,
}: ChatAnnouncementSettingsProps) {
  const t = useTranslations("chatAnnouncementSettings");

  // State管理
  const [enabled, setEnabled] = useState(currentEnabled);
  const [template, setTemplate] = useState(currentTemplate || "");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [isError, setIsError] = useState(false);

  // スコープ確認用のstate
  // State for scope check
  const [hasScope, setHasScope] = useState<boolean | null>(null);
  const [checkingScope, setCheckingScope] = useState(true);
  const [reauthorizing, setReauthorizing] = useState(false);

  // コンポーネントマウント時にスコープをチェック
  // Check scope on component mount
  useEffect(() => {
    checkScope();
  }, []);

  /**
   * user:write:chatスコープが付与されているかチェック
   * Check if user:write:chat scope is granted
   */
  const checkScope = async () => {
    setCheckingScope(true);
    try {
      const response = await fetch("/api/auth/check-scope?scope=user:write:chat", {
        credentials: "include",
      });

      if (response.ok) {
        const data = await response.json();
        setHasScope(data.hasScope);
      } else {
        setHasScope(false);
      }
    } catch (error) {
      logger.error("Scope check error:", error);
      setHasScope(false);
    } finally {
      setCheckingScope(false);
    }
  };

  /**
   * 追加スコープを取得するために再認証を開始
   * Start re-authentication to get additional scope
   */
  const handleReauthorize = useCallback(async () => {
    setReauthorizing(true);
    setMessage("");
    setIsError(false);

    try {
      const response = await fetch("/api/auth/reauth", {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": getCsrfTokenFromCookie(),
        },
        body: JSON.stringify({
          additionalScopes: ["user:write:chat"],
        }),
      });

      if (response.ok) {
        const data = await response.json();

        // state をCookieに保存してからリダイレクト
        // Save state to cookie before redirect
        if (data.state) {
          document.cookie = `twitch_auth_state=${data.state}; path=/; max-age=600; secure; samesite=lax`;
        }

        // Twitch認証ページにリダイレクト
        // Redirect to Twitch authorization page
        window.location.href = data.loginUrl;
      } else {
        const errorData = await response.json();
        setMessage(errorData.error || t("errors.reauthorizeFailed"));
        setIsError(true);
        setReauthorizing(false);
      }
    } catch (error) {
      logger.error("Reauthorize error:", error);
      setMessage(t("errors.reauthorizeFailed"));
      setIsError(true);
      setReauthorizing(false);
    }
  }, [t]);

  /**
   * 設定を保存
   * Save settings
   */
  const saveSettings = async (newEnabled: boolean, newTemplate: string) => {
    setSaving(true);
    setMessage("");
    setIsError(false);

    try {
      const response = await fetch("/api/streamer/settings", {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": getCsrfTokenFromCookie(),
        },
        body: JSON.stringify({
          streamerId,
          chatAnnouncementEnabled: newEnabled,
          chatAnnouncementTemplate: newTemplate || null,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        setMessage(errorData.error || t("errors.saveFailed"));
        setIsError(true);
        return false;
      }

      setMessage(t("messages.saved"));
      setIsError(false);
      return true;
    } catch (error) {
      logger.error("Save settings error:", error);
      setMessage(t("errors.saveFailed"));
      setIsError(true);
      return false;
    } finally {
      setSaving(false);
    }
  };

  /**
   * 有効/無効を切り替え
   * Toggle enabled state
   */
  const handleToggleEnabled = useCallback(async () => {
    const newEnabled = !enabled;
    setEnabled(newEnabled);

    const success = await saveSettings(newEnabled, template);
    if (!success) {
      // 失敗した場合は元に戻す
      // Revert on failure
      setEnabled(!newEnabled);
    }
  }, [enabled, template]);

  /**
   * テンプレートを保存
   * Save template
   */
  const handleSaveTemplate = useCallback(async () => {
    await saveSettings(enabled, template);
  }, [enabled, template]);

  // スコープ確認中のローディング表示
  // Loading display while checking scope
  if (checkingScope) {
    return (
      <div className="rounded-xl bg-gray-800 p-6">
        <h2 className="text-xl font-semibold text-white mb-4">
          {t("title")}
        </h2>
        <p className="text-sm text-gray-400">{t("messages.checkingScope")}</p>
      </div>
    );
  }

  return (
    <div className="rounded-xl bg-gray-800 p-6">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-xl font-semibold text-white">
          {t("title")}
        </h2>
        {/* 有効/無効ステータス表示 */}
        <span
          className={`inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs ${
            enabled && hasScope
              ? "bg-green-500/20 text-green-400"
              : "bg-gray-500/20 text-gray-400"
          }`}
        >
          <span
            className={`h-2 w-2 rounded-full ${
              enabled && hasScope ? "bg-green-500" : "bg-gray-500"
            }`}
          />
          {enabled && hasScope ? t("status.enabled") : t("status.disabled")}
        </span>
      </div>

      <p className="mb-4 text-sm text-gray-400">
        {t("description")}
      </p>

      {/* スコープ未取得時の警告と再認証ボタン */}
      {/* Warning and reauthorize button when scope is not granted */}
      {!hasScope && (
        <div className="mb-4 rounded-lg bg-yellow-500/10 border border-yellow-500/30 p-4">
          <p className="text-sm text-yellow-400 mb-3">
            {t("scopeWarning")}
          </p>
          <button
            onClick={handleReauthorize}
            disabled={reauthorizing}
            className="rounded-lg bg-purple-600 px-4 py-2 text-sm text-white hover:bg-purple-700 disabled:opacity-50"
          >
            {reauthorizing ? t("buttons.reauthorizing") : t("buttons.reauthorize")}
          </button>
        </div>
      )}

      <div className={`space-y-4 ${!hasScope ? "opacity-50 pointer-events-none" : ""}`}>
        {/* 有効/無効切り替え */}
        <div className="flex items-center gap-3">
          <label className="relative inline-flex cursor-pointer items-center">
            <input
              type="checkbox"
              checked={enabled}
              onChange={handleToggleEnabled}
              disabled={saving || !hasScope}
              className="peer sr-only"
            />
            <div
              className="h-6 w-11 rounded-full bg-gray-600 after:absolute after:left-[2px] after:top-[2px] after:h-5 after:w-5 after:rounded-full after:border after:border-gray-300 after:bg-white after:transition-all after:content-[''] peer-checked:bg-purple-600 peer-checked:after:translate-x-full peer-checked:after:border-white peer-disabled:opacity-50"
            />
          </label>
          <span className="text-sm text-gray-300">
            {t("form.enableAnnouncement")}
          </span>
        </div>

        {/* カスタムテンプレート入力 */}
        <div>
          <label className="mb-1 block text-sm text-gray-300">
            {t("form.customTemplate")}
          </label>
          <textarea
            value={template}
            onChange={(e) => setTemplate(e.target.value)}
            placeholder={t("form.templatePlaceholder")}
            disabled={!hasScope}
            rows={3}
            className="w-full rounded-lg border border-gray-600 bg-gray-700 px-3 py-2 text-sm text-white placeholder-gray-500 focus:border-purple-500 focus:outline-none disabled:opacity-50"
          />
          <p className="mt-1 text-xs text-gray-500">
            {t("form.placeholderHelp")}
          </p>
        </div>

        {/* テンプレート保存ボタン */}
        <button
          onClick={handleSaveTemplate}
          disabled={saving || !hasScope}
          className="rounded-lg bg-purple-600 px-4 py-2 text-sm text-white hover:bg-purple-700 disabled:opacity-50"
        >
          {saving ? t("buttons.saving") : t("buttons.saveTemplate")}
        </button>

        {/* ステータスメッセージ */}
        {message && (
          <p className={`text-sm ${isError ? "text-red-400" : "text-green-400"}`}>
            {message}
          </p>
        )}
      </div>
    </div>
  );
}
