"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import type { PlanType } from "@/lib/plan-constants";
import { PLAN_STORAGE_BONUS } from "@/lib/plan-constants";

interface SupportPlanSectionProps {
  currentPlan: PlanType;
}

// プラン表示名とスタイル
const PLAN_STYLES: Record<PlanType, { color: string; bgColor: string }> = {
  basic: { color: "text-gray-400", bgColor: "bg-gray-600" },
  support: { color: "text-blue-400", bgColor: "bg-blue-600" },
  patron: { color: "text-yellow-400", bgColor: "bg-yellow-600" },
  twitch_sub: { color: "text-purple-400", bgColor: "bg-purple-600" },
};

/**
 * 支援プランセクション - アカウント設定ページで使用
 * コード入力フォームと現在のプラン表示を含む
 */
export default function SupportPlanSection({ currentPlan }: SupportPlanSectionProps) {
  const t = useTranslations("supportPlan");
  const router = useRouter();

  const [code, setCode] = useState("");
  const [fanboxId, setFanboxId] = useState("");
  const [loading, setLoading] = useState(false);
  const [deactivating, setDeactivating] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  // アクティベーション成功後にプランを楽観的に更新
  // router.refresh() でサーバーから新しい currentPlan が渡された場合も同期する
  const [activePlan, setActivePlan] = useState<PlanType>(currentPlan);
  useEffect(() => { setActivePlan(currentPlan); }, [currentPlan]);

  const formatBytes = (bytes: number): string => {
    if (bytes === 0) return "0 MB";
    const mb = bytes / (1024 * 1024);
    if (mb >= 1024) return `${(mb / 1024).toFixed(0)} GB`;
    return `${mb.toFixed(0)} MB`;
  };

  const handleActivate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!code.trim()) return;

    setLoading(true);
    setMessage(null);

    try {
      const response = await fetch("/api/support/activate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        credentials: "include",
        body: JSON.stringify({
          code: code.trim(),
          fanboxId: fanboxId.trim() || undefined,
        }),
      });

      const data = await response.json();

      if (response.ok && data.success) {
        setMessage({ type: "success", text: t("messages.activated", { plan: t(`plans.${data.planType}`) }) });
        setActivePlan(data.planType as PlanType);
        setCode("");
        setFanboxId("");
        // サーバーコンポーネント（カード管理等）にプラン変更を反映
        router.refresh();
      } else {
        setMessage({ type: "error", text: data.error || t("messages.activateFailed") });
      }
    } catch {
      setMessage({ type: "error", text: t("messages.networkError") });
    } finally {
      setLoading(false);
    }
  };

  const handleDeactivate = async () => {
    if (!window.confirm(t("form.confirmDeactivate"))) return;

    setDeactivating(true);
    setMessage(null);

    try {
      const response = await fetch("/api/support/deactivate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        credentials: "include",
      });

      const data = await response.json();

      if (response.ok && data.success) {
        setMessage({ type: "success", text: t("messages.deactivated") });
        setActivePlan((data.planType as PlanType) ?? "basic");
        router.refresh();
      } else {
        setMessage({ type: "error", text: data.error || t("messages.deactivateFailed") });
      }
    } catch {
      setMessage({ type: "error", text: t("messages.networkError") });
    } finally {
      setDeactivating(false);
    }
  };

  const planStyle = PLAN_STYLES[activePlan];
  const storageBonus = PLAN_STORAGE_BONUS[activePlan];

  return (
    <div className="rounded-xl bg-gray-800 p-6">
      <h2 className="mb-4 text-xl font-semibold text-white">
        {t("title")}
      </h2>

      {/* 現在のプラン表示 */}
      <div className="mb-6 rounded-lg bg-gray-700/50 p-4">
        <div className="flex items-center gap-3 mb-3">
          <span className="text-sm text-gray-400">{t("currentPlan")}:</span>
          <span className={`rounded-full px-3 py-1 text-sm font-medium text-white ${planStyle.bgColor}`}>
            {t(`plans.${activePlan}`)}
          </span>
        </div>
        {/* 特典一覧 */}
        <div className="space-y-1 text-sm text-gray-400">
          <p>
            {t("storageBonus")}: <span className={planStyle.color}>+{formatBytes(storageBonus)}</span>
            {storageBonus === 0 && <span className="ml-1">({t("defaultStorage")})</span>}
          </p>
        </div>
      </div>

      {/* コード入力フォーム */}
      <form onSubmit={handleActivate} className="space-y-4">
        <p className="text-sm text-gray-400">
          {t("description")}
          {" "}
          <a href="/plans" className="text-purple-400 hover:text-purple-300 underline">
            支援特典について
          </a>
        </p>
        <div>
          <label className="mb-1 block text-sm text-gray-300">{t("form.code")}</label>
          <input
            type="text"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder={t("form.codePlaceholder")}
            maxLength={64}
            className="w-full rounded-lg bg-gray-600 px-4 py-2 text-white placeholder-gray-400"
            disabled={loading || deactivating}
          />
        </div>
        <div>
          <label className="mb-1 block text-sm text-gray-300">
            {t("form.fanboxId")}
            <span className="ml-1 text-xs text-gray-500">({t("form.optional")})</span>
          </label>
          <input
            type="text"
            value={fanboxId}
            onChange={(e) => setFanboxId(e.target.value)}
            placeholder={t("form.fanboxIdPlaceholder")}
            maxLength={100}
            className="w-full rounded-lg bg-gray-600 px-4 py-2 text-white placeholder-gray-400"
            disabled={loading || deactivating}
          />
        </div>

        {/* メッセージ表示 */}
        {message && (
          <div className={`rounded-lg p-3 text-sm ${
            message.type === "success"
              ? "bg-green-900/30 border border-green-600/50 text-green-300"
              : "bg-red-900/30 border border-red-600/50 text-red-300"
          }`}>
            {message.text}
          </div>
        )}

        <button
          type="submit"
          disabled={loading || deactivating || !code.trim()}
          className="rounded-lg bg-purple-600 px-6 py-2 text-white hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {loading ? t("form.activating") : t("form.activate")}
        </button>
      </form>

      {/* 素地への復帰ボタン（basic以外かつtwitch_sub以外の時のみ表示）
         twitch_subはTwitchサブスクで自動判定されるため、コード解除では無効化できない */}
      {activePlan !== "basic" && activePlan !== "twitch_sub" && (
        <div className="mt-4 border-t border-gray-700 pt-4">
          <button
            onClick={handleDeactivate}
            disabled={loading || deactivating}
            className="rounded-lg bg-gray-600 px-6 py-2 text-sm text-gray-300 hover:bg-gray-500 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {deactivating ? t("form.deactivating") : t("form.deactivate")}
          </button>
        </div>
      )}
    </div>
  );
}
