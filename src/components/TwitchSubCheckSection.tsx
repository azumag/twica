"use client";

import { useState, useEffect, useCallback } from "react";
import { useTranslations } from "next-intl";

interface TwitchSubCheckSectionProps {
  initialHasSub: boolean;
}

/**
 * CookieからCSRFトークンを取得
 */
function getCsrfToken(): string {
  if (typeof document === "undefined") return "";
  return document.cookie
    .split("; ")
    .find(row => row.startsWith("csrf_token="))
    ?.split("=")[1] || "";
}

/**
 * Twitch サブスク確認セクション - アカウント設定ページで使用
 * user:read:subscriptions スコープの再認証と、サブスク状態の手動確認を提供する。
 * ChatAnnouncementSettings の再認証パターンを踏襲。
 */
export default function TwitchSubCheckSection({
  initialHasSub,
}: TwitchSubCheckSectionProps) {
  const t = useTranslations("twitchSub");

  const [hasScope, setHasScope] = useState<boolean | null>(null);
  const [checkingScope, setCheckingScope] = useState(true);
  const [hasSub, setHasSub] = useState(initialHasSub);
  const [checking, setChecking] = useState(false);
  const [reauthorizing, setReauthorizing] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  // マウント時にスコープを確認
  useEffect(() => {
    (async () => {
      setCheckingScope(true);
      try {
        const response = await fetch("/api/auth/check-scope?scope=user:read:subscriptions", {
          credentials: "include",
        });
        if (response.ok) {
          const data = await response.json();
          setHasScope(data.hasScope);
        } else {
          setHasScope(false);
        }
      } catch {
        setHasScope(false);
      } finally {
        setCheckingScope(false);
      }
    })();
  }, []);

  /**
   * user:read:subscriptions スコープを取得するための再認証
   */
  const handleReauthorize = useCallback(async () => {
    setReauthorizing(true);
    setMessage(null);

    try {
      const response = await fetch("/api/auth/reauth", {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": getCsrfToken(),
        },
        body: JSON.stringify({
          additionalScopes: ["user:read:subscriptions"],
        }),
      });

      if (response.ok) {
        const data = await response.json();
        if (data.state) {
          document.cookie = `twitch_auth_state=${data.state}; path=/; max-age=600; secure; samesite=lax`;
        }
        window.location.href = data.loginUrl;
      } else {
        const errorData = await response.json();
        setMessage({ type: "error", text: errorData.error || t("messages.reauthorizeFailed") });
        setReauthorizing(false);
      }
    } catch {
      setMessage({ type: "error", text: t("messages.networkError") });
      setReauthorizing(false);
    }
  }, [t]);

  /**
   * サブスク状態を手動確認
   */
  const handleCheckSubscription = async () => {
    setChecking(true);
    setMessage(null);

    try {
      const response = await fetch("/api/auth/twitch/check-subscription", {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": getCsrfToken(),
        },
      });

      const data = await response.json();

      if (response.ok && data.success) {
        setHasSub(data.hasSub);
        setMessage({
          type: "success",
          text: data.hasSub ? t("messages.subActive") : t("messages.subInactive"),
        });
      } else if (data.needsReauth) {
        setHasScope(false);
        setMessage({ type: "error", text: t("messages.needsReauth") });
      } else {
        setMessage({ type: "error", text: data.error || t("messages.checkFailed") });
      }
    } catch {
      setMessage({ type: "error", text: t("messages.networkError") });
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="rounded-xl bg-gray-800 p-6">
      <h2 className="mb-2 text-xl font-semibold text-white">{t("title")}</h2>
      <p className="mb-4 text-sm text-gray-400">{t("description")}</p>

      {/* 現在のサブスク状態 */}
      <div className="mb-4 rounded-lg bg-gray-700/50 p-4">
        <div className="flex items-center gap-2">
          <span className="text-sm text-gray-400">{t("status")}:</span>
          <span className={hasSub ? "text-green-400 font-medium" : "text-gray-400"}>
            {hasSub ? t("statusActive") : t("statusInactive")}
          </span>
        </div>
      </div>

      {/* スコープ未付与時の警告・再認証ボタン */}
      {!checkingScope && hasScope === false && (
        <div className="mb-4 rounded-lg border border-yellow-600/50 bg-yellow-900/20 p-4">
          <p className="mb-3 text-sm text-yellow-300">{t("scopeWarning")}</p>
          <button
            onClick={handleReauthorize}
            disabled={reauthorizing}
            className="rounded-lg bg-purple-600 px-4 py-2 text-sm text-white hover:bg-purple-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {reauthorizing ? t("buttons.reauthorizing") : t("buttons.reauthorize")}
          </button>
        </div>
      )}

      {/* メッセージ表示 */}
      {message && (
        <div className={`mb-4 rounded-lg p-3 text-sm ${
          message.type === "success"
            ? "border border-green-600/50 bg-green-900/30 text-green-300"
            : "border border-red-600/50 bg-red-900/30 text-red-300"
        }`}>
          {message.text}
        </div>
      )}

      {/* サブスク確認ボタン（スコープ付与済みの場合のみ有効） */}
      <button
        onClick={handleCheckSubscription}
        disabled={checking || checkingScope || hasScope === false}
        className="rounded-lg bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {checking ? t("buttons.checking") : t("buttons.checkSubscription")}
      </button>
    </div>
  );
}
