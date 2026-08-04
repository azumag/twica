"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { parseMaintenanceError } from "@/lib/maintenance/client";
import { parseTwitchAuthorizationResponse } from "@/lib/twitch/authorization-response";
import { useMaintenanceStatus } from "./MaintenanceStatusProvider";

interface TwitchSubCheckSectionProps {
  initialHasSub: boolean;
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
  const tMaintenance = useTranslations("maintenance");
  const router = useRouter();
  // #694 Stage 6c: /dashboard/account は dashboard/layout.tsx の
  // MaintenanceStatusProvider配下（Context経由でmode取得）。
  const { mode: maintenanceMode } = useMaintenanceStatus();
  const isMaintenanceBlocked = maintenanceMode !== "off";

  const [hasScope, setHasScope] = useState<boolean | null>(null);
  const [checkingScope, setCheckingScope] = useState(true);
  const [hasSub, setHasSub] = useState(initialHasSub);
  const [checking, setChecking] = useState(false);
  const [disabling, setDisabling] = useState(false);
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
    // 事前disable(ボタン)をすり抜けた場合でも、fetch自体を発火させないための二重ガード。
    // #694 Stage 6cレビュー指摘: /api/auth/reauth もconfig/maintenance-write-surfaces.json
    // で block 対象の書き込みroute（state cookie発行の副作用を持つ）のため、
    // check-subscription/disable-subscriptionと同じガードを適用する。
    if (isMaintenanceBlocked) {
      setMessage({ type: "error", text: tMaintenance("writeDisabled") });
      return;
    }

    setReauthorizing(true);
    setMessage(null);

    try {
      const response = await fetch("/api/auth/reauth", {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          additionalScopes: ["user:read:subscriptions"],
        }),
      });

      if (response.ok) {
        const data = await response.json();
        // 壊れたAPI応答や侵害時の外部URLをそのままwindow.locationへ渡さないため、
        // ChatAnnouncementSettingsのreauth/BOT接続と同じorigin/path/state検証を通す
        // （Issue #865フォローアップ）。
        const authorization = parseTwitchAuthorizationResponse(data);
        if (!authorization) {
          setMessage({ type: "error", text: t("messages.reauthorizeFailed") });
          setReauthorizing(false);
          return;
        }
        document.cookie = `twitch_auth_state=${authorization.state}; path=/; max-age=600; secure; samesite=lax`;
        window.location.href = authorization.loginUrl;
      } else {
        const errorData = await response.json();
        const maintenanceError = parseMaintenanceError(response, errorData);
        setMessage({ type: "error", text: maintenanceError?.message || errorData.error || t("messages.reauthorizeFailed") });
        setReauthorizing(false);
      }
    } catch {
      setMessage({ type: "error", text: t("messages.networkError") });
      setReauthorizing(false);
    }
  }, [t, tMaintenance, isMaintenanceBlocked]);

  /**
   * サブスク状態を手動確認
   */
  const handleCheckSubscription = async () => {
    if (disabling) return;

    // 事前disable(ボタン)をすり抜けた場合でも、fetch自体を発火させないための二重ガード。
    if (isMaintenanceBlocked) {
      setMessage({ type: "error", text: tMaintenance("writeDisabled") });
      return;
    }

    setChecking(true);
    setMessage(null);

    try {
      const response = await fetch("/api/auth/twitch/check-subscription", {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
        },
      });

      const data = await response.json();

      if (response.ok && data.success) {
        if (data.saved === false) {
          const codeSuffix = data.saveFailureCode ? ` (${data.saveFailureCode})` : "";
          setMessage({ type: "error", text: `${t("messages.saveFailed")}${codeSuffix}` });
        } else {
          setHasSub(data.hasSub);
          setMessage({
            type: "success",
            text: data.hasSub ? t("messages.subActive") : t("messages.subInactive"),
          });
          // サーバーコンポーネント（カード管理等）にプラン変更を反映
          router.refresh();
        }
      } else if (data.needsReauth) {
        setHasScope(false);
        setMessage({ type: "error", text: t("messages.needsReauth") });
      } else {
        // maintenance mode による503拒否ならサーバーの案内文言を優先する。
        const maintenanceError = parseMaintenanceError(response, data);
        setMessage({ type: "error", text: maintenanceError?.message || data.error || t("messages.checkFailed") });
      }
    } catch {
      setMessage({ type: "error", text: t("messages.networkError") });
    } finally {
      setChecking(false);
    }
  };

  /**
   * サブスク状態を手動で無効化
   */
  const handleDisableSubscription = async () => {
    if (checking) return;

    const confirmed = window.confirm(t("messages.confirmDisable"));
    if (!confirmed) return;

    // 事前disable(ボタン)をすり抜けた場合でも、fetch自体を発火させないための二重ガード。
    if (isMaintenanceBlocked) {
      setMessage({ type: "error", text: tMaintenance("writeDisabled") });
      return;
    }

    setDisabling(true);
    setMessage(null);

    try {
      const response = await fetch("/api/auth/twitch/disable-subscription", {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
        },
      });

      let data: { success?: boolean; error?: string } = {};
      try {
        data = await response.json();
      } catch {
        // no-op: レスポンスボディが空/不正なら汎用エラー文言へフォールバック
      }

      if (response.ok && data.success) {
        setHasSub(false);
        setMessage({ type: "success", text: t("messages.disabled") });
        router.refresh();
      } else {
        // maintenance mode による503拒否ならサーバーの案内文言を優先する。
        const maintenanceError = parseMaintenanceError(response, data);
        setMessage({ type: "error", text: maintenanceError?.message || data.error || t("messages.disableFailed") });
      }
    } catch {
      setMessage({ type: "error", text: t("messages.networkError") });
    } finally {
      setDisabling(false);
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
            disabled={reauthorizing || isMaintenanceBlocked}
            title={isMaintenanceBlocked ? tMaintenance("writeDisabled") : undefined}
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

      {isMaintenanceBlocked && (
        <p className="mb-4 text-sm text-yellow-400">{tMaintenance("writeDisabled")}</p>
      )}

      <div className="flex flex-wrap gap-2">
        {/* サブスク確認ボタン（スコープ付与済みの場合のみ有効） */}
        <button
          onClick={handleCheckSubscription}
          disabled={checking || disabling || checkingScope || hasScope === false || isMaintenanceBlocked}
          title={isMaintenanceBlocked ? tMaintenance("writeDisabled") : undefined}
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {checking ? t("buttons.checking") : t("buttons.checkSubscription")}
        </button>

        {/* サブスク有効時のみ手動無効化ボタンを表示 */}
        {hasSub && (
          <button
            onClick={handleDisableSubscription}
            disabled={disabling || checking || isMaintenanceBlocked}
            title={isMaintenanceBlocked ? tMaintenance("writeDisabled") : undefined}
            className="rounded-lg bg-gray-600 px-4 py-2 text-sm text-white hover:bg-gray-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {disabling ? t("buttons.disabling") : t("buttons.disable")}
          </button>
        )}
      </div>
    </div>
  );
}
