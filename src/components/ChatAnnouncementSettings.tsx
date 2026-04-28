"use client";

import { useState, useCallback, useEffect, useMemo } from "react";
import { useTranslations } from "next-intl";
import { logger } from "@/lib/logger";
import { CARD_DESCRIPTION_MAX_CHARACTERS, TWITCH_CHAT_MESSAGE_MAX_CHARACTERS } from "@/lib/constants";
import { countCharacters } from "@/lib/text-utils";

interface ChatAnnouncementSettingsProps {
  streamerId: string;
  // チャット通知の有効/無効状態
  // Whether chat announcement is enabled
  currentEnabled: boolean;
  // カスタムテンプレート（nullの場合はデフォルト）
  // Custom template (null for default)
  currentTemplate: string | null;
}

const DEFAULT_CHAT_TEMPLATE = "@{user} が【{rarity}】{card} を獲得しました！";

const MAX_TEMPLATE_PLACEHOLDER_LENGTHS = {
  user: 25,
  card: 100,
  rarity: 12,
  num: 10,
  // コンプ進捗のユニーク/全種類数は現実的に4桁で十分
  // Collection progress counts realistically fit in 4 digits
  unique: 4,
  all: 4,
  detail: CARD_DESCRIPTION_MAX_CHARACTERS,
} as const;

function buildChatPreviewMessage(
  template: string,
  placeholders: {
    user: string;
    card: string;
    rarity: string;
    num: string;
    unique: string;
    all: string;
    detail: string;
    url: string;
  }
): string {
  return template
    .replace(/\{user\}/g, placeholders.user)
    .replace(/\{card\}/g, placeholders.card)
    .replace(/\{rarity\}/g, placeholders.rarity)
    .replace(/\{num\}/g, placeholders.num)
    .replace(/\{unique\}/g, placeholders.unique)
    .replace(/\{all\}/g, placeholders.all)
    .replace(/\{detail\}/g, placeholders.detail)
    .replace(/\{url\}/g, placeholders.url)
    .replace(/\s+/g, " ")
    .trim();
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

  // チャットデモ用のstate
  // State for chat demo
  const [showDemoModal, setShowDemoModal] = useState(false);

  // スコープ確認用のstate
  // State for scope check
  const [hasScope, setHasScope] = useState<boolean | null>(null);
  const [checkingScope, setCheckingScope] = useState(true);
  const [reauthorizing, setReauthorizing] = useState(false);
  const activeTemplate = template || DEFAULT_CHAT_TEMPLATE;

  const demoMessage = useMemo(() => {
    return buildChatPreviewMessage(activeTemplate, {
      user: "SampleUser",
      card: "レジェンダリーカード",
      rarity: "レジェンダリー",
      num: "3",
      unique: "5",
      all: "10",
      detail: "特別なカードの説明文です",
      url: `https://twica.live/collection/${streamerId}`,
    });
  }, [activeTemplate, streamerId]);

  const demoMessageCharacterCount = useMemo(
    () => countCharacters(demoMessage),
    [demoMessage]
  );

  const estimatedMaxMessageCharacterCount = useMemo(() => {
    return countCharacters(
      buildChatPreviewMessage(activeTemplate, {
        user: "U".repeat(MAX_TEMPLATE_PLACEHOLDER_LENGTHS.user),
        card: "カ".repeat(MAX_TEMPLATE_PLACEHOLDER_LENGTHS.card),
        rarity: "レ".repeat(MAX_TEMPLATE_PLACEHOLDER_LENGTHS.rarity),
        num: "9".repeat(MAX_TEMPLATE_PLACEHOLDER_LENGTHS.num),
        unique: "9".repeat(MAX_TEMPLATE_PLACEHOLDER_LENGTHS.unique),
        all: "9".repeat(MAX_TEMPLATE_PLACEHOLDER_LENGTHS.all),
        detail: "説".repeat(MAX_TEMPLATE_PLACEHOLDER_LENGTHS.detail),
        url: `https://twica.live/collection/${streamerId}`,
      })
    );
  }, [activeTemplate, streamerId]);

  const mayExceedChatLimit = estimatedMaxMessageCharacterCount > TWITCH_CHAT_MESSAGE_MAX_CHARACTERS;

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
  const saveSettings = useCallback(async (newEnabled: boolean, newTemplate: string) => {
    setSaving(true);
    setMessage("");
    setIsError(false);

    try {
      const response = await fetch("/api/streamer/settings", {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
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
  }, [streamerId, t]);

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
  }, [enabled, saveSettings, template]);

  /**
   * テンプレートを保存
   * Save template
   */
  const handleSaveTemplate = useCallback(async () => {
    await saveSettings(enabled, template);
  }, [enabled, saveSettings, template]);

  /**
   * デモ用のサンプルメッセージを生成
   * Generate sample message for demo preview
   */
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

      <p className="mb-2 text-sm text-gray-400">
        {t("description")}
      </p>
      <p className="mb-2 text-xs text-gray-500">
        {t("demoNote")}
      </p>
      <p className="mb-4 text-xs text-gray-500">
        {t("noLineBreakNote")}
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
          <p className={`mt-1 text-xs ${demoMessageCharacterCount > TWITCH_CHAT_MESSAGE_MAX_CHARACTERS ? "text-yellow-400" : "text-gray-500"}`}>
            {t("form.previewLength", {
              current: demoMessageCharacterCount,
              max: TWITCH_CHAT_MESSAGE_MAX_CHARACTERS,
            })}
          </p>
          {mayExceedChatLimit && (
            <div className="mt-2 rounded-lg border border-yellow-500/30 bg-yellow-500/10 p-3 text-xs text-yellow-300">
              {t("messages.lengthWarning", {
                estimated: estimatedMaxMessageCharacterCount,
                max: TWITCH_CHAT_MESSAGE_MAX_CHARACTERS,
              })}
            </div>
          )}
        </div>

        {/* ボタン群 */}
        <div className="flex gap-2">
          {/* テンプレート保存ボタン */}
          <button
            onClick={handleSaveTemplate}
            disabled={saving || !hasScope}
            className="rounded-lg bg-purple-600 px-4 py-2 text-sm text-white hover:bg-purple-700 disabled:opacity-50"
          >
            {saving ? t("buttons.saving") : t("buttons.saveTemplate")}
          </button>

          {/* チャットデモボタン */}
          <button
            onClick={() => setShowDemoModal(true)}
            disabled={!hasScope}
            className="rounded-lg bg-gray-600 px-4 py-2 text-sm text-white hover:bg-gray-500 disabled:opacity-50"
          >
            {t("buttons.chatDemo")}
          </button>
        </div>

        {/* ステータスメッセージ */}
        {message && (
          <p className={`text-sm ${isError ? "text-red-400" : "text-green-400"}`}>
            {message}
          </p>
        )}
      </div>

      {/* チャットデモモーダル */}
      {/* Chat demo modal */}
      {showDemoModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="mx-4 w-full max-w-md rounded-lg bg-gray-800 p-6 shadow-xl">
            <h3 className="mb-2 text-lg font-semibold text-white">
              {t("demo.title")}
            </h3>
            <p className="mb-4 text-xs text-gray-400">
              {t("demo.description")}
            </p>
            {/* プレビューメッセージ */}
            <div className="mb-4 rounded-lg bg-gray-700 p-4">
              <p className="break-words text-sm text-white">
                {demoMessage}
              </p>
            </div>
            <button
              onClick={() => setShowDemoModal(false)}
              className="w-full rounded-lg bg-purple-600 px-4 py-2 text-sm text-white hover:bg-purple-700"
            >
              {t("demo.close")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
