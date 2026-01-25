"use client";

import { useState, useEffect, useCallback } from "react";
import { useTranslations } from "next-intl";
import { logger } from "@/lib/logger";


interface TwitchReward {
  id: string;
  title: string;
  cost: number;
  is_enabled: boolean;
}

interface EventSubSubscription {
  id: string;
  status: string;
  type: string;
  condition: {
    broadcaster_user_id: string;
    reward_id?: string;
  };
  transport?: {
    callback?: string;
  };
  debug?: {
    expectedCallbackUrl: string;
    callbackMatch: boolean;
  };
}

interface ChannelPointSettingsProps {
  streamerId: string;
  currentRewardId: string | null;
  currentRewardName: string | null;
}

/**
 * Channel Point Settings Component
 * Manages Twitch channel point reward configuration for card redemption
 * チャネルポイント設定コンポーネント - カード引き換え用のTwitchチャネルポイント報酬設定を管理
 */
export default function ChannelPointSettings({
  streamerId,
  currentRewardId,
  currentRewardName,
}: ChannelPointSettingsProps) {
  const t = useTranslations("channelPointSettings");
  const tCommon = useTranslations("common");
  const [rewards, setRewards] = useState<TwitchReward[]>([]);
  const [selectedRewardId, setSelectedRewardId] = useState(currentRewardId || "");
  const [selectedRewardName, setSelectedRewardName] = useState(currentRewardName || "");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [creating, setCreating] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [eventSubStatus, setEventSubStatus] = useState<"none" | "pending" | "active" | "error">("none");
  const [subscriptions, setSubscriptions] = useState<EventSubSubscription[]>([]);

  const fetchRewards = async () => {
    setLoading(true);
    setError("");

    try {
      const response = await fetch("/api/twitch/rewards", {
        credentials: "include",
      });

      if (response.status === 401) {
        const errorData = await response.json();
        if (errorData.requiresReauth) {
          setError("報酬の取得に失敗しました。再度ログインしてください。");
        } else {
          setError(t("messages.fetchFailed"));
        }
        setLoading(false);
        return;
      }

      if (response.status === 403) {
        setError(t("messages.affiliateRequired"));
        setLoading(false);
        return;
      }

      if (response.status === 429) {
        const errorData = await response.json();
        setError(errorData.error || t("messages.rateLimit"));
        setLoading(false);
        return;
      }

      if (!response.ok) {
        const errorData = await response.json();
        setError(errorData.error || "報酬の取得に失敗しました");
        setLoading(false);
        return;
      }

      const data = await response.json();
      setRewards(data);
    } catch (err) {
      logger.error("Failed to fetch rewards:", err);
      setError(t("messages.fetchFailed"));
    } finally {
      setLoading(false);
    }
  };

  // targetRewardIdを引数で受け取ることで、保存直後に最新のrewardIdで比較できる
  // 引数が省略された場合はselectedRewardIdを使用（初期ロード時など）
  const fetchEventSubStatus = useCallback(async (targetRewardId?: string) => {
    const rewardIdToCheck = targetRewardId ?? selectedRewardId;
    logger.info("[EventSub] fetchEventSubStatus called", { targetRewardId, selectedRewardId, rewardIdToCheck });
    try {
      const response = await fetch("/api/twitch/eventsub/subscribe", {
        credentials: "include",
      });
      if (response.ok) {
        const subs = await response.json();
        logger.info("[EventSub] API response", { subsCount: subs.length, subs: subs.map((s: EventSubSubscription) => ({ id: s.id, status: s.status, reward_id: s.condition.reward_id })) });
        setSubscriptions(subs);

        // Check if we have an active subscription for the target reward
        // 引数で渡されたrewardIdを使うことで、保存直後でも正しく判定できる
        const activeSub = subs.find(
          (sub: EventSubSubscription) =>
            sub.status === "enabled" &&
            sub.condition.reward_id === rewardIdToCheck
        );

        logger.info("[EventSub] Status check", { activeSub: !!activeSub, rewardIdToCheck, subsLength: subs.length });

        if (activeSub) {
          logger.info("[EventSub] Setting status to ACTIVE");
          setEventSubStatus("active");
        } else if (subs.length > 0) {
          logger.info("[EventSub] Setting status to PENDING");
          setEventSubStatus("pending");
        } else {
          logger.info("[EventSub] Setting status to NONE");
          setEventSubStatus("none");
        }
      }
      } catch {
        logger.error("Failed to fetch EventSub status");
      }
  }, [selectedRewardId]);

  // 初期ロード時のみ実行
  // currentRewardId（props）を渡すことで、DBに保存されている報酬IDでステータスを確認
  // 依存配列を空にすることで、保存後の再実行を防ぐ
  useEffect(() => {
    fetchRewards();
    // 初期ロード時はpropsのcurrentRewardIdを使用
    fetchEventSubStatus(currentRewardId || undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleCreateReward = async () => {
    setCreating(true);
    setMessage("");

    try {
      const response = await fetch("/api/twitch/rewards", {
        method: "POST",
        credentials: "include",
      });

      if (response.ok) {
        const newReward = await response.json();
        setRewards([...rewards, newReward]);
        setSelectedRewardId(newReward.id);
        setSelectedRewardName(newReward.title);
        setMessage(t("messages.rewardCreated"));
      } else if (response.status === 429) {
        const errorData = await response.json();
        setMessage(errorData.error || t("messages.rateLimit"));
      } else {
        setMessage(t("messages.createRewardFailed"));
      }
    } catch {
      setMessage(t("messages.errorOccurred"));
    } finally {
      setCreating(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setMessage("");

    try {
      // Save settings
      const settingsResponse = await fetch("/api/streamer/settings", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          streamerId,
          channelPointRewardId: selectedRewardId,
          channelPointRewardName: selectedRewardName,
        }),
      });

      if (settingsResponse.status === 429) {
        const errorData = await settingsResponse.json();
        setMessage(errorData.error || t("messages.rateLimit"));
        return;
      }

      if (!settingsResponse.ok) {
        setMessage(t("messages.saveFailed"));
        return;
      }

      // Subscribe to EventSub
      const eventSubResponse = await fetch("/api/twitch/eventsub/subscribe", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rewardId: selectedRewardId,
        }),
      });

      const eventSubData = await eventSubResponse.json();

      // レスポンスのsuccessフィールドで判定（ステータスコードではなく）
      if (eventSubData.success) {
        setMessage(eventSubData.message || t("messages.saveSuccess"));
        setEventSubStatus("pending");
        // Refresh status - 保存した報酬IDを明示的に渡して正しく比較
        await fetchEventSubStatus(selectedRewardId);
      } else if (eventSubData.warning) {
        // 警告状態：サブスクリプションの確認が必要
        setMessage(eventSubData.message || "状態を確認してください");
        setEventSubStatus("pending");
        await fetchEventSubStatus(selectedRewardId);
      } else if (eventSubResponse.status === 429) {
        setMessage(eventSubData.error || t("messages.rateLimit"));
      } else {
        logger.error("EventSub error:", eventSubData);
        setMessage(eventSubData.error || t("messages.eventsubFailed"));
        setEventSubStatus("error");
      }
    } catch {
      setMessage(t("messages.errorOccurred"));
    } finally {
      setSaving(false);
    }
  };

  const handleRewardSelect = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const rewardId = e.target.value;
    setSelectedRewardId(rewardId);

    const reward = rewards.find((r) => r.id === rewardId);
    setSelectedRewardName(reward?.title || "");
  };

  const getEventSubStatusBadge = () => {
    switch (eventSubStatus) {
      case "active":
        return (
          <span className="inline-flex items-center gap-1 rounded-full bg-green-500/20 px-2 py-1 text-xs text-green-400">
            <span className="h-2 w-2 rounded-full bg-green-500"></span>
            {t("status.active")}
          </span>
        );
      case "pending":
        return (
          <span className="inline-flex items-center gap-1 rounded-full bg-yellow-500/20 px-2 py-1 text-xs text-yellow-400">
            <span className="h-2 w-2 rounded-full bg-yellow-500"></span>
            {t("status.pending")}
          </span>
        );
      case "error":
        return (
          <span className="inline-flex items-center gap-1 rounded-full bg-red-500/20 px-2 py-1 text-xs text-red-400">
            <span className="h-2 w-2 rounded-full bg-red-500"></span>
            {t("status.error")}
          </span>
        );
      default:
        return (
          <span className="inline-flex items-center gap-1 rounded-full bg-gray-500/20 px-2 py-1 text-xs text-gray-400">
            <span className="h-2 w-2 rounded-full bg-gray-500"></span>
            {t("status.none")}
          </span>
        );
    }
  };

  return (
    <div className="rounded-xl bg-gray-800 p-6">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-xl font-semibold text-white">
          {t("title")}
        </h2>
        {getEventSubStatusBadge()}
      </div>

       {error ? (
         <div className="rounded-lg bg-red-500/20 p-4 text-red-300">
           {error}
         </div>
       ) : loading ? (
         <div className="text-gray-400">{tCommon("loading")}</div>
       ) : (
         <div className="space-y-4">
           <div>
             <label className="mb-1 block text-sm text-gray-300">
               {t("form.selectReward")}
             </label>
             <select
               value={selectedRewardId}
               onChange={handleRewardSelect}
               className="w-full rounded-lg bg-gray-700 px-4 py-2 text-gray-200"
             >
               <option value="">{t("options.selectReward")}</option>
               {rewards.map((reward) => (
                 <option key={reward.id} value={reward.id}>
                   {reward.title} ({reward.cost} {t("options.points")})
                   {!reward.is_enabled && t("options.disabled")}
                 </option>
               ))}
             </select>
           </div>

           {rewards.length === 0 && (
             <div className="rounded-lg bg-gray-700 p-4">
               <p className="mb-3 text-sm text-gray-400">
                 {t("form.noRewards")}
               </p>
               <button
                 onClick={handleCreateReward}
                 disabled={creating}
                 className="rounded-lg bg-purple-600 px-4 py-2 text-sm text-white hover:bg-purple-700 disabled:opacity-50"
               >
                 {creating ? t("buttons.creating") : t("buttons.createReward")}
               </button>
             </div>
           )}

           {selectedRewardId && (
             <div className="rounded-lg bg-gray-700 p-3">
               <p className="text-sm text-gray-400">
                 {t("form.selected")} <span className="text-white">{selectedRewardName}</span>
               </p>
               <p className="mt-1 text-xs text-gray-500">
                 {t("form.id")} {selectedRewardId}
               </p>
             </div>
           )}

           {/* EventSub Info */}
           <div className="rounded-lg bg-gray-700/50 p-4">
             <h3 className="mb-2 text-sm font-medium text-gray-300">{t("form.eventsubStatus")}</h3>
             {subscriptions.length > 0 ? (
               <div className="space-y-2">
                 {subscriptions.map((sub) => (
                   <div key={sub.id}>
                     <div className="flex items-center justify-between text-xs">
                       <span className="text-gray-400">
                         {sub.condition.reward_id ? `${t("form.rewardId")} ${sub.condition.reward_id.slice(0, 8)}...` : t("form.allRewards")}
                       </span>
                       <span className={sub.status === "enabled" ? "text-green-400" : "text-yellow-400"}>
                         {sub.status}
                       </span>
                     </div>
                     {/* Explanation for pending verification status */}
                     {/* 検証待ち状態の説明 */}
                     {sub.status === "webhook_callback_verification_pending" && (
                       <div className="mt-1 rounded bg-yellow-500/10 p-2 text-xs text-yellow-300">
                         <p className="font-medium">Webhook検証待ち</p>
                         <p className="mt-1 text-yellow-400/80">
                           TwitchがWebhookエンドポイントの検証を試みています。
                           通常は数秒〜数分で完了します。
                         </p>
                         <ul className="mt-1 list-inside list-disc text-yellow-400/70">
                           <li>サーバーが正常に動作しているか確認してください</li>
                           <li>しばらく待ってから「更新」ボタンを押してください</li>
                           <li>解決しない場合は、報酬を再設定してみてください</li>
                         </ul>
                       </div>
                     )}
                     {/* Callback URL mismatch warning */}
                     {/* Callback URL不一致の警告 */}
                     {sub.debug && !sub.debug.callbackMatch && (
                       <div className="mt-1 rounded bg-red-500/10 p-2 text-xs text-red-300">
                         <p className="font-medium">Callback URL不一致</p>
                         <p className="mt-1 text-red-400/80">
                           登録されているCallback URLと現在のアプリURLが一致しません。
                           EventSubを再登録してください。
                         </p>
                         <p className="mt-1 text-red-400/60 break-all">
                           現在: {sub.transport?.callback || "不明"}
                         </p>
                         <p className="text-red-400/60 break-all">
                           期待: {sub.debug.expectedCallbackUrl}
                         </p>
                       </div>
                     )}
                   </div>
                 ))}
               </div>
             ) : (
               <p className="text-xs text-gray-500">
                 {t("form.noSubscriptions")}
               </p>
             )}
             {process.env.NODE_ENV === 'development' && (
              <p className="mt-2 text-xs text-gray-500">
                {t("form.localTunnelNote")}
              </p>
            )}
           </div>

           <div className="flex items-center gap-4">
             <button
               onClick={handleSave}
               disabled={saving || !selectedRewardId}
               className="rounded-lg bg-purple-600 px-6 py-2 text-white hover:bg-purple-700 disabled:opacity-50"
             >
               {saving ? tCommon("loading") : t("buttons.saveEventSub")}
             </button>
             <button
               onClick={() => { fetchRewards(); fetchEventSubStatus(); }}
               className="rounded-lg border border-gray-600 px-4 py-2 text-gray-300 hover:bg-gray-700"
             >
               {tCommon("refresh")}
             </button>
              {message && (
                <span
                  className={
                    // Check if message is a success message by comparing with translated values
                    // 翻訳された値と比較して成功メッセージかどうかを確認
                    [t("messages.rewardCreated"), t("messages.saveSuccess")].includes(message)
                      ? "text-green-400"
                      : "text-red-400"
                  }
                >
                  {message}
                </span>
              )}
          </div>
        </div>
      )}
    </div>
  );
}
