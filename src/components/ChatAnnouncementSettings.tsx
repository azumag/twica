"use client";

import { useState, useCallback, useEffect, useMemo } from "react";
import { useTranslations } from "next-intl";
import { logger } from "@/lib/logger";
import { CARD_DESCRIPTION_MAX_CHARACTERS, TWITCH_CHAT_MESSAGE_MAX_CHARACTERS } from "@/lib/constants";
import { countCharacters } from "@/lib/text-utils";
import { MAX_COLLECTION_NAME_LENGTH } from "@/lib/validation/collection-name";

interface ChatAnnouncementSettingsProps {
  streamerId: string;
  // チャット通知の有効/無効状態
  // Whether chat announcement is enabled
  currentEnabled: boolean;
  // カスタムテンプレート（nullの場合はデフォルト）
  // Custom template (null for default)
  currentTemplate: string | null;
  currentMultiTemplate: string | null;
  currentMultiShowCards: boolean;
  botAccount?: {
    username: string | null;
    displayName: string | null;
  } | null;
}

const DEFAULT_CHAT_TEMPLATE = "@{user} が【{rarity}】{card} を獲得しました！";
const DEFAULT_MULTI_DRAW_CHAT_TEMPLATE = "@{user} が{draws}連ガチャで {rarityCounts} を獲得しました！{cards}";

const MAX_TEMPLATE_PLACEHOLDER_LENGTHS = {
  user: 25,
  card: 100,
  cards: 300,
  rarity: 12,
  num: 10,
  // コンプ進捗のユニーク/全種類数は現実的に4桁で十分
  // Collection progress counts realistically fit in 4 digits
  unique: 4,
  all: 4,
  detail: CARD_DESCRIPTION_MAX_CHARACTERS,
  // newCards は cards と同等の上限（実装上は 「初出: 」付与時に予約される）
  // newCards mirrors `cards` length; runtime reserves space for the "初出: " suffix
  newCards: 300,
  newCardCount: 4,
  // パック名の上限はDBのCHECK制約（MAX_COLLECTION_NAME_LENGTH）に合わせる
  // Pack name limit mirrors the DB CHECK constraint (MAX_COLLECTION_NAME_LENGTH)
  packName: MAX_COLLECTION_NAME_LENGTH,
} as const;

function buildChatPreviewMessage(
  template: string,
  placeholders: {
    user: string;
    card: string;
    cards: string;
    draws: string;
    rarityCounts: string;
    rarity: string;
    num: string;
    unique: string;
    all: string;
    detail: string;
    url: string;
    newCards: string;
    newCardCount: string;
    packName: string;
  }
): string {
  return template
    .replace(/\{user\}/g, placeholders.user)
    .replace(/\{card\}/g, placeholders.card)
    .replace(/\{cards\}/g, placeholders.cards)
    .replace(/\{draws\}/g, placeholders.draws)
    .replace(/\{rarityCounts\}/g, placeholders.rarityCounts)
    .replace(/\{rarity\}/g, placeholders.rarity)
    .replace(/\{num\}/g, placeholders.num)
    .replace(/\{unique\}/g, placeholders.unique)
    .replace(/\{all\}/g, placeholders.all)
    .replace(/\{detail\}/g, placeholders.detail)
    .replace(/\{url\}/g, placeholders.url)
    .replace(/\{newCards\}/g, placeholders.newCards)
    .replace(/\{newCardCount\}/g, placeholders.newCardCount)
    .replace(/\{packName\}/g, placeholders.packName)
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
  currentMultiTemplate,
  currentMultiShowCards,
  botAccount,
}: ChatAnnouncementSettingsProps) {
  const t = useTranslations("chatAnnouncementSettings");

  // State管理
  const [enabled, setEnabled] = useState(currentEnabled);
  const [template, setTemplate] = useState(currentTemplate || "");
  const [multiTemplate, setMultiTemplate] = useState(currentMultiTemplate || "");
  const [multiShowCards, setMultiShowCards] = useState(currentMultiShowCards);
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
  const [botConnected, setBotConnected] = useState(Boolean(botAccount));
  const [botDisplayName, setBotDisplayName] = useState(botAccount?.displayName || botAccount?.username || "");
  const [botConnecting, setBotConnecting] = useState(false);
  const [botDisconnecting, setBotDisconnecting] = useState(false);
  const activeTemplate = template || DEFAULT_CHAT_TEMPLATE;
  const activeMultiTemplate = multiTemplate || DEFAULT_MULTI_DRAW_CHAT_TEMPLATE;
  const canSendChat = hasScope || botConnected;

  // {newCards}/{newCardCount} は multiShowCards（カード名一覧表示）が有効なときのみ値が入り、
  // 無効時は本文生成ロジック側で空文字に置換される（#487仕様、本PRでは変更しない）。
  // 誤設定に気づきにくいため、テンプレートがこれらを使っているのに表示設定がOFFの場合は警告する。
  // {newCards}/{newCardCount} only get content when multiShowCards (card-name list display) is
  // enabled; otherwise the message-building logic replaces them with an empty string (existing
  // #487 behavior, unchanged by this PR). Since that's easy to misconfigure without noticing,
  // warn when the template references them while the display toggle is off.
  const usesNewCardPlaceholders = useMemo(
    () => /\{newCards\}|\{newCardCount\}/.test(activeMultiTemplate),
    [activeMultiTemplate]
  );
  const showNewCardPlaceholderWarning = usesNewCardPlaceholders && !multiShowCards;

  const demoMessage = useMemo(() => {
    return buildChatPreviewMessage(activeTemplate, {
      user: "SampleUser",
      card: "レジェンダリーカード",
      cards: "レジェンダリーカード、レアカード、コモンカード",
      draws: "3",
      rarityCounts: "レジェンダリーx1、レアx1、コモンx1",
      rarity: "レジェンダリー",
      num: "3",
      unique: "5",
      all: "10",
      detail: "特別なカードの説明文です",
      url: `https://twica.live/collection/${streamerId}`,
      newCards: "レジェンダリーカード、レアカード",
      newCardCount: "2",
      packName: "サンプルパック",
    });
  }, [activeTemplate, streamerId]);

  const multiDemoMessage = useMemo(() => {
    return buildChatPreviewMessage(activeMultiTemplate, {
      user: "SampleUser",
      card: "レジェンダリーカード",
      cards: multiShowCards ? "（レジェンダリーカード、レアカード、コモンカード）" : "",
      draws: "3",
      rarityCounts: "レジェンダリーx1、レアx1、コモンx1",
      rarity: "レジェンダリー",
      num: "3",
      unique: "5",
      all: "10",
      detail: "特別なカードの説明文です",
      url: `https://twica.live/collection/${streamerId}`,
      newCards: multiShowCards ? "レジェンダリーカード、レアカード" : "",
      newCardCount: multiShowCards ? "2" : "",
      packName: "サンプルパック",
    });
  }, [activeMultiTemplate, multiShowCards, streamerId]);

  const demoMessageCharacterCount = useMemo(
    () => countCharacters(demoMessage),
    [demoMessage]
  );

  const estimatedMaxMessageCharacterCount = useMemo(() => {
    return countCharacters(
      buildChatPreviewMessage(activeTemplate, {
        user: "U".repeat(MAX_TEMPLATE_PLACEHOLDER_LENGTHS.user),
        card: "カ".repeat(MAX_TEMPLATE_PLACEHOLDER_LENGTHS.card),
        cards: "カ".repeat(MAX_TEMPLATE_PLACEHOLDER_LENGTHS.cards),
        draws: "10",
        rarityCounts: "レジェンダリーx10",
        rarity: "レ".repeat(MAX_TEMPLATE_PLACEHOLDER_LENGTHS.rarity),
        num: "9".repeat(MAX_TEMPLATE_PLACEHOLDER_LENGTHS.num),
        unique: "9".repeat(MAX_TEMPLATE_PLACEHOLDER_LENGTHS.unique),
        all: "9".repeat(MAX_TEMPLATE_PLACEHOLDER_LENGTHS.all),
        detail: "説".repeat(MAX_TEMPLATE_PLACEHOLDER_LENGTHS.detail),
        url: `https://twica.live/collection/${streamerId}`,
        newCards: "カ".repeat(MAX_TEMPLATE_PLACEHOLDER_LENGTHS.newCards),
        newCardCount: "9".repeat(MAX_TEMPLATE_PLACEHOLDER_LENGTHS.newCardCount),
        packName: "パ".repeat(MAX_TEMPLATE_PLACEHOLDER_LENGTHS.packName),
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

  const handleConnectBot = useCallback(async () => {
    setBotConnecting(true);
    setMessage("");
    setIsError(false);

    try {
      const response = await fetch("/api/auth/bot/connect", {
        method: "POST",
        credentials: "include",
      });

      if (response.ok) {
        const data = await response.json();
        window.location.href = data.loginUrl;
        return;
      }

      const errorData = await response.json();
      setMessage(errorData.error || t("errors.botConnectFailed"));
      setIsError(true);
    } catch (error) {
      logger.error("Alternate account connect error:", error);
      setMessage(t("errors.botConnectFailed"));
      setIsError(true);
    } finally {
      setBotConnecting(false);
    }
  }, [t]);

  const handleDisconnectBot = useCallback(async () => {
    setBotDisconnecting(true);
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
          disconnectBot: true,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        setMessage(errorData.error || t("errors.botDisconnectFailed"));
        setIsError(true);
        return;
      }

      setBotConnected(false);
      setBotDisplayName("");
      setMessage(t("messages.botDisconnected"));
      setIsError(false);
    } catch (error) {
      logger.error("Alternate account disconnect error:", error);
      setMessage(t("errors.botDisconnectFailed"));
      setIsError(true);
    } finally {
      setBotDisconnecting(false);
    }
  }, [streamerId, t]);

  /**
   * 設定を保存
   * Save settings
   */
  const saveSettings = useCallback(async (
    newEnabled: boolean,
    newTemplate: string,
    newMultiTemplate: string,
    newMultiShowCards: boolean
  ) => {
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
          chatAnnouncementMultiTemplate: newMultiTemplate || null,
          chatAnnouncementMultiShowCards: newMultiShowCards,
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

    const success = await saveSettings(newEnabled, template, multiTemplate, multiShowCards);
    if (!success) {
      // 失敗した場合は元に戻す
      // Revert on failure
      setEnabled(!newEnabled);
    }
  }, [enabled, multiShowCards, multiTemplate, saveSettings, template]);

  /**
   * テンプレートを保存
   * Save template
   */
  const handleSaveTemplate = useCallback(async () => {
    await saveSettings(enabled, template, multiTemplate, multiShowCards);
  }, [enabled, multiShowCards, multiTemplate, saveSettings, template]);

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
            enabled && canSendChat
              ? "bg-green-500/20 text-green-400"
              : "bg-gray-500/20 text-gray-400"
          }`}
        >
          <span
            className={`h-2 w-2 rounded-full ${
              enabled && canSendChat ? "bg-green-500" : "bg-gray-500"
            }`}
          />
          {enabled && canSendChat ? t("status.enabled") : t("status.disabled")}
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
      {!canSendChat && (
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

      <div className="mb-4 rounded-lg border border-gray-700 bg-gray-900/40 p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-medium text-white">
              {t("bot.title")}
            </p>
            <p className="mt-1 text-xs text-gray-400">
              {botConnected
                ? t("bot.connectedAs", { name: botDisplayName })
                : t("bot.description")}
            </p>
          </div>
          {botConnected ? (
            <button
              onClick={handleDisconnectBot}
              disabled={botDisconnecting}
              className="shrink-0 whitespace-nowrap rounded-lg bg-gray-600 px-4 py-2 text-sm text-white hover:bg-gray-500 disabled:opacity-50"
            >
              {botDisconnecting ? t("buttons.disconnectingBot") : t("buttons.disconnectBot")}
            </button>
          ) : (
            <button
              onClick={handleConnectBot}
              disabled={botConnecting}
              className="shrink-0 whitespace-nowrap rounded-lg bg-purple-600 px-4 py-2 text-sm text-white hover:bg-purple-700 disabled:opacity-50"
            >
              {botConnecting ? t("buttons.connectingBot") : t("buttons.connectBot")}
            </button>
          )}
        </div>
      </div>

      <div className={`space-y-4 ${!canSendChat ? "opacity-50 pointer-events-none" : ""}`}>
        {/* 有効/無効切り替え */}
        <div className="flex items-center gap-3">
          <label className="relative inline-flex cursor-pointer items-center">
            <input
              type="checkbox"
              checked={enabled}
              onChange={handleToggleEnabled}
              disabled={saving || !canSendChat}
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
            disabled={!canSendChat}
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

        <div className="rounded-lg border border-gray-700 bg-gray-900/40 p-4">
          <label className="mb-1 block text-sm text-gray-300">
            {t("form.multiTemplate")}
          </label>
          <textarea
            value={multiTemplate}
            onChange={(e) => setMultiTemplate(e.target.value)}
            placeholder={t("form.multiTemplatePlaceholder")}
            disabled={!canSendChat}
            rows={3}
            className="w-full rounded-lg border border-gray-600 bg-gray-700 px-3 py-2 text-sm text-white placeholder-gray-500 focus:border-purple-500 focus:outline-none disabled:opacity-50"
          />
          <p className="mt-1 text-xs text-gray-500">
            {t("form.multiPlaceholderHelp")}
          </p>
          <label className="mt-3 flex items-center gap-2 text-sm text-gray-300">
            <input
              type="checkbox"
              checked={multiShowCards}
              onChange={(e) => setMultiShowCards(e.target.checked)}
              disabled={!canSendChat}
              className="h-4 w-4 rounded border-gray-600 bg-gray-700 text-purple-600 focus:ring-purple-500 disabled:opacity-50"
            />
            {t("form.multiShowCards")}
          </label>
          {/* #504: multiShowCards無効時に{newCards}/{newCardCount}が空文字化される仕様は */}
          {/* 誤設定に見えやすいため、テンプレートがこれらを使っている場合のみ警告を表示する */}
          {/* #504: warn when the template uses {newCards}/{newCardCount} while multiShowCards */}
          {/* is off, since the resulting empty-string substitution otherwise looks like a bug */}
          {showNewCardPlaceholderWarning && (
            <div className="mt-2 rounded-lg border border-yellow-500/30 bg-yellow-500/10 p-3 text-xs text-yellow-300">
              {t("messages.newCardPlaceholderWarning")}
            </div>
          )}
        </div>

        {/* ボタン群 */}
        <div className="flex gap-2">
          {/* テンプレート保存ボタン */}
          <button
            onClick={handleSaveTemplate}
            disabled={saving || !canSendChat}
            className="rounded-lg bg-purple-600 px-4 py-2 text-sm text-white hover:bg-purple-700 disabled:opacity-50"
          >
            {saving ? t("buttons.saving") : t("buttons.saveTemplate")}
          </button>

          {/* チャットデモボタン */}
          <button
            onClick={() => setShowDemoModal(true)}
            disabled={!canSendChat}
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
              <p className="mb-2 text-xs text-gray-400">{t("demo.singleTitle")}</p>
              <p className="break-words text-sm text-white">
                {demoMessage}
              </p>
            </div>
            <div className="mb-4 rounded-lg bg-gray-700 p-4">
              <p className="mb-2 text-xs text-gray-400">{t("demo.multiTitle")}</p>
              <p className="break-words text-sm text-white">
                {multiDemoMessage}
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
