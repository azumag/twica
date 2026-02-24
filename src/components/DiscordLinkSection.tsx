"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";

interface DiscordLinkSectionProps {
  discordUserId: string | null;
  discordSubVerified: boolean; // Discord サブスクライバーロール確認済みか
  initialError?: string | null; // OAuth コールバックエラー（リダイレクト経由）
}

/**
 * Discord連携セクション - アカウント設定ページで使用
 * Discordアカウントの連携・解除・ロール更新機能を提供する
 */
export default function DiscordLinkSection({
  discordUserId,
  discordSubVerified,
  initialError = null,
}: DiscordLinkSectionProps) {
  const t = useTranslations("discord");

  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(
    initialError
      ? {
          type: "error",
          text:
            initialError === "DISCORD_ALREADY_LINKED"
              ? t("messages.alreadyLinked")
              : t("messages.networkError"),
        }
      : null
  );

  /** CSRFトークンをCookieから取得（SupportPlanSection.tsx と同一パターン） */
  const getCsrfToken = (): string => {
    return (
      document.cookie
        .split("; ")
        .find((row) => row.startsWith("csrf_token="))
        ?.split("=")[1] ?? ""
    );
  };

  /** Discord連携解除 */
  const handleUnlink = async () => {
    if (!window.confirm(t("unlinkConfirm"))) return;

    setLoading(true);
    setMessage(null);

    try {
      const response = await fetch("/api/auth/discord/unlink", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": getCsrfToken(),
        },
        credentials: "include",
      });

      const data = await response.json();

      if (response.ok && data.success) {
        setMessage({ type: "success", text: t("messages.unlinkSuccess") });
        // ページリロードして状態を反映
        window.location.reload();
      } else {
        setMessage({ type: "error", text: data.error || t("messages.unlinkFailed") });
      }
    } catch {
      setMessage({ type: "error", text: t("messages.networkError") });
    } finally {
      setLoading(false);
    }
  };

  /** Discordサブスクライバーロール更新 */
  const handleRefreshRole = async () => {
    setLoading(true);
    setMessage(null);

    try {
      const response = await fetch("/api/auth/discord/refresh-role", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": getCsrfToken(),
        },
        credentials: "include",
      });

      const data = await response.json();

      if (response.ok && data.success) {
        setMessage({ type: "success", text: t("messages.refreshSuccess") });
        window.location.reload();
      } else {
        setMessage({ type: "error", text: data.error || t("messages.refreshFailed") });
      }
    } catch {
      setMessage({ type: "error", text: t("messages.networkError") });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="rounded-xl bg-gray-800 p-6">
      <h2 className="mb-2 text-xl font-semibold text-white">{t("title")}</h2>
      <p className="mb-6 text-sm text-gray-400">{t("description")}</p>

      {discordUserId ? (
        /* 連携済み状態 */
        <div className="space-y-4">
          {/* 連携状態 */}
          <div className="rounded-lg bg-gray-700/50 p-4 space-y-2">
            <div className="flex items-center gap-2">
              <span className="rounded-full bg-green-600 px-2 py-0.5 text-xs font-medium text-white">
                {t("linked")}
              </span>
            </div>
            <p className="text-sm text-gray-400">
              {t("userId")}:{" "}
              <span className="font-mono text-gray-200">{discordUserId}</span>
            </p>
            <p className="text-sm text-gray-400">
              {t("roleStatus")}:{" "}
              <span className={discordSubVerified ? "text-green-400" : "text-gray-400"}>
                {discordSubVerified ? t("roleActive") : t("roleInactive")}
              </span>
            </p>
          </div>

          {/* メッセージ表示 */}
          {message && (
            <div
              className={`rounded-lg p-3 text-sm ${
                message.type === "success"
                  ? "border border-green-600/50 bg-green-900/30 text-green-300"
                  : "border border-red-600/50 bg-red-900/30 text-red-300"
              }`}
            >
              {message.text}
            </div>
          )}

          {/* ロール更新・連携解除ボタン */}
          <div className="flex gap-3">
            <button
              onClick={handleRefreshRole}
              disabled={loading}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {t("refreshButton")}
            </button>
            <button
              onClick={handleUnlink}
              disabled={loading}
              className="rounded-lg bg-gray-600 px-4 py-2 text-sm text-gray-300 hover:bg-gray-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {t("unlinkButton")}
            </button>
          </div>
        </div>
      ) : (
        /* 未連携状態 */
        <div className="space-y-4">
          <div className="rounded-lg bg-gray-700/50 p-4">
            <span className="rounded-full bg-gray-600 px-2 py-0.5 text-xs font-medium text-gray-300">
              {t("notLinked")}
            </span>
          </div>

          {/* メッセージ表示 */}
          {message && (
            <div
              className={`rounded-lg p-3 text-sm ${
                message.type === "success"
                  ? "border border-green-600/50 bg-green-900/30 text-green-300"
                  : "border border-red-600/50 bg-red-900/30 text-red-300"
              }`}
            >
              {message.text}
            </div>
          )}

          <button
            onClick={() => {
              window.location.href = "/api/auth/discord/login?redirect=true";
            }}
            className="rounded-lg bg-indigo-600 px-6 py-2 text-white hover:bg-indigo-700"
          >
            {t("linkButton")}
          </button>
        </div>
      )}
    </div>
  );
}
