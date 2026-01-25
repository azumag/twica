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
}

// 追加ガチャ報酬の型定義
// Type definition for additional gacha rewards
interface AdditionalGachaReward {
  id: string;
  streamer_id: string;
  reward_id: string;
  reward_name: string | null;
  created_at: string;
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
  // 追加報酬関連の状態
  // State for additional rewards
  const [additionalRewards, setAdditionalRewards] = useState<AdditionalGachaReward[]>([]);
  const [selectedAdditionalRewardId, setSelectedAdditionalRewardId] = useState("");
  const [addingAdditional, setAddingAdditional] = useState(false);
  const [removingAdditional, setRemovingAdditional] = useState<string | null>(null);
  // メイン報酬解除中フラグ
  // Main reward removal in progress flag
  const [removing, setRemoving] = useState(false);

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

  const fetchEventSubStatus = useCallback(async () => {
    try {
      const response = await fetch("/api/twitch/eventsub/subscribe", {
        credentials: "include",
      });
      if (response.ok) {
        const subs = await response.json();
        setSubscriptions(subs);

        // Check if we have an active subscription for the current reward
        const activeSub = subs.find(
          (sub: EventSubSubscription) =>
            sub.status === "enabled" &&
            sub.condition.reward_id === currentRewardId
        );

        if (activeSub) {
          setEventSubStatus("active");
        } else if (subs.length > 0) {
          setEventSubStatus("pending");
        } else {
          setEventSubStatus("none");
        }
      }
      } catch {
        logger.error("Failed to fetch EventSub status");
      }
  }, [currentRewardId]);

  // 追加報酬一覧を取得
  // Fetch additional rewards list
  const fetchAdditionalRewards = useCallback(async () => {
    try {
      const response = await fetch("/api/twitch/eventsub/additional-rewards", {
        credentials: "include",
      });
      if (response.ok) {
        const data = await response.json();
        setAdditionalRewards(data);
      }
    } catch {
      logger.error("Failed to fetch additional rewards");
    }
  }, []);

  useEffect(() => {
    fetchRewards();
    fetchEventSubStatus();
    fetchAdditionalRewards();
  }, [fetchEventSubStatus, fetchAdditionalRewards]);

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

      if (eventSubResponse.ok) {
        setMessage(t("messages.saveSuccess"));
        setEventSubStatus("pending");
        // Refresh status
        await fetchEventSubStatus();
      } else if (eventSubResponse.status === 429) {
        const errorData = await eventSubResponse.json();
        setMessage(errorData.error || t("messages.rateLimit"));
      } else {
        const errorData = await eventSubResponse.json();
        logger.error("EventSub error:", errorData);
        setMessage(t("messages.eventsubFailed"));
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

  // 追加報酬を登録
  // Add additional reward
  const handleAddAdditionalReward = async () => {
    if (!selectedAdditionalRewardId) return;

    setAddingAdditional(true);
    setMessage("");

    try {
      const reward = rewards.find((r) => r.id === selectedAdditionalRewardId);
      const response = await fetch("/api/twitch/eventsub/additional-rewards", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rewardId: selectedAdditionalRewardId,
          rewardName: reward?.title || null,
        }),
      });

      if (response.ok) {
        setMessage(t("messages.additionalRewardAdded"));
        setSelectedAdditionalRewardId("");
        await fetchAdditionalRewards();
        await fetchEventSubStatus();
      } else if (response.status === 429) {
        const errorData = await response.json();
        setMessage(errorData.error || t("messages.rateLimit"));
      } else {
        const errorData = await response.json();
        setMessage(errorData.error || t("messages.additionalRewardFailed"));
      }
    } catch {
      setMessage(t("messages.errorOccurred"));
    } finally {
      setAddingAdditional(false);
    }
  };

  // メイン報酬設定を解除
  // Remove main reward setting from server
  const handleRemoveReward = async () => {
    setRemoving(true);
    setMessage("");

    try {
      // まずEventSubサブスクリプションを削除
      // First delete EventSub subscription
      const eventSubResponse = await fetch(
        `/api/twitch/eventsub/subscribe?rewardId=${encodeURIComponent(currentRewardId!)}`,
        {
          method: "DELETE",
          credentials: "include",
        }
      );

      if (!eventSubResponse.ok && eventSubResponse.status !== 404) {
        if (eventSubResponse.status === 429) {
          const errorData = await eventSubResponse.json();
          setMessage(errorData.error || t("messages.rateLimit"));
          return;
        }
        // サブスクリプション削除に失敗しても設定の解除は続行
        // Continue with settings removal even if subscription deletion fails
        logger.warn("Failed to delete EventSub subscription, continuing with settings removal");
      }

      // サーバーから設定を解除（nullを保存）
      // Remove settings from server (save null)
      const settingsResponse = await fetch("/api/streamer/settings", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          streamerId,
          channelPointRewardId: null,
          channelPointRewardName: null,
        }),
      });

      if (settingsResponse.status === 429) {
        const errorData = await settingsResponse.json();
        setMessage(errorData.error || t("messages.rateLimit"));
        return;
      }

      if (!settingsResponse.ok) {
        setMessage(t("messages.removeFailed"));
        return;
      }

      setMessage(t("messages.removeSuccess"));
      // UIの状態もクリア
      // Clear UI state as well
      setSelectedRewardId("");
      setSelectedRewardName("");
      setEventSubStatus("none");
      await fetchEventSubStatus();
      // ページをリロードして最新の状態を反映
      // Reload page to reflect the latest state
      window.location.reload();
    } catch {
      setMessage(t("messages.errorOccurred"));
    } finally {
      setRemoving(false);
    }
  };

  // 追加報酬を削除
  // Remove additional reward
  const handleRemoveAdditionalReward = async (rewardId: string) => {
    setRemovingAdditional(rewardId);
    setMessage("");

    try {
      const response = await fetch(
        `/api/twitch/eventsub/additional-rewards?rewardId=${encodeURIComponent(rewardId)}`,
        {
          method: "DELETE",
          credentials: "include",
        }
      );

      if (response.ok) {
        setMessage(t("messages.additionalRewardRemoved"));
        await fetchAdditionalRewards();
        await fetchEventSubStatus();
      } else if (response.status === 429) {
        const errorData = await response.json();
        setMessage(errorData.error || t("messages.rateLimit"));
      } else {
        setMessage(t("messages.additionalRewardRemoveFailed"));
      }
    } catch {
      setMessage(t("messages.errorOccurred"));
    } finally {
      setRemovingAdditional(null);
    }
  };

  // 追加報酬として選択可能な報酬をフィルタリング
  // Filter rewards available for additional selection
  const availableForAdditional = rewards.filter(
    (r) =>
      r.id !== selectedRewardId && // メイン報酬は除外
      r.id !== currentRewardId && // 現在のメイン報酬も除外
      !additionalRewards.some((ar) => ar.reward_id === r.id) // 既に追加済みは除外
  );

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
             <div className="flex items-center justify-between rounded-lg bg-gray-700 p-3">
               <div className="min-w-0 flex-1">
                 <p className="truncate text-sm text-gray-400">
                   {t("form.selected")} <span className="text-white">{selectedRewardName}</span>
                 </p>
                 <p className="mt-1 truncate text-xs text-gray-500">
                   {t("form.id")} {selectedRewardId}
                 </p>
               </div>
               <button
                 onClick={() => {
                   // ドロップダウンの選択をクリアするだけ（保存前）
                   // Clear dropdown selection only (before save)
                   setSelectedRewardId("");
                   setSelectedRewardName("");
                 }}
                 className="ml-3 shrink-0 rounded bg-gray-600 px-2 py-1 text-xs text-gray-300 hover:bg-gray-500"
               >
                 {t("buttons.clear")}
               </button>
             </div>
           )}

           {/* 保存済み設定の解除ボタン - サーバーから設定を削除 */}
           {/* Remove saved settings button - delete settings from server */}
           {currentRewardId && (
             <div className="flex items-center justify-between rounded-lg bg-yellow-500/10 p-3">
               <div className="min-w-0 flex-1">
                 <p className="text-sm text-yellow-300">
                   {t("form.currentSetting")}: <span className="text-white">{currentRewardName}</span>
                 </p>
               </div>
               <button
                 onClick={handleRemoveReward}
                 disabled={removing}
                 className="ml-3 shrink-0 rounded bg-red-600/20 px-3 py-1 text-sm text-red-400 hover:bg-red-600/30 disabled:opacity-50"
               >
                 {removing ? tCommon("loading") : t("buttons.removeReward")}
               </button>
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

           {/* Additional Rewards Section - Only show when main reward is saved */}
           {/* 追加報酬セクション - メインの報酬が保存されている場合のみ表示 */}
           {currentRewardId && (
             <div className="rounded-lg bg-gray-700/50 p-4">
               <h3 className="mb-2 text-sm font-medium text-gray-300">
                 {t("form.additionalRewards")}
               </h3>
               <p className="mb-3 text-xs text-gray-500">
                 {t("form.additionalRewardsDescription")}
               </p>

               {/* Registered additional rewards list */}
               {/* 登録済みの追加報酬一覧 */}
               {additionalRewards.length > 0 && (
                 <div className="mb-3 space-y-2">
                   {additionalRewards.map((reward) => (
                     <div
                       key={reward.id}
                       className="flex items-center justify-between gap-2 rounded bg-gray-600/50 px-3 py-2"
                     >
                       <div className="min-w-0 flex-1">
                         <span className="block truncate text-sm text-gray-200">
                           {reward.reward_name || t("form.unknownReward")}
                         </span>
                         <span className="text-xs text-gray-500">
                           ({reward.reward_id.slice(0, 8)}...)
                         </span>
                       </div>
                       <button
                         onClick={() => handleRemoveAdditionalReward(reward.reward_id)}
                         disabled={removingAdditional === reward.reward_id}
                         className="shrink-0 rounded bg-red-600/20 px-2 py-1 text-xs text-red-400 hover:bg-red-600/30 disabled:opacity-50"
                       >
                         {removingAdditional === reward.reward_id
                           ? tCommon("loading")
                           : t("buttons.remove")}
                       </button>
                     </div>
                   ))}
                 </div>
               )}

               {/* Add additional reward form */}
               {/* 追加報酬の追加フォーム */}
               {availableForAdditional.length > 0 ? (
                 <div className="flex items-center gap-2">
                   <select
                     value={selectedAdditionalRewardId}
                     onChange={(e) => setSelectedAdditionalRewardId(e.target.value)}
                     className="min-w-0 flex-1 rounded-lg bg-gray-700 px-3 py-2 text-sm text-gray-200"
                   >
                     <option value="">{t("options.selectAdditionalReward")}</option>
                     {availableForAdditional.map((reward) => (
                       <option key={reward.id} value={reward.id}>
                         {reward.title} ({reward.cost} {t("options.points")})
                         {!reward.is_enabled && t("options.disabled")}
                       </option>
                     ))}
                   </select>
                   <button
                     onClick={handleAddAdditionalReward}
                     disabled={addingAdditional || !selectedAdditionalRewardId}
                     className="shrink-0 rounded-lg bg-purple-600 px-4 py-2 text-sm text-white hover:bg-purple-700 disabled:opacity-50"
                   >
                     {addingAdditional ? tCommon("loading") : t("buttons.addAdditional")}
                   </button>
                 </div>
               ) : (
                 <p className="text-xs text-gray-500">
                   {t("form.noAdditionalRewardsAvailable")}
                 </p>
               )}
             </div>
           )}

           <div className="flex items-center gap-4">
             <button
               onClick={handleSave}
               disabled={saving || !selectedRewardId}
               className="rounded-lg bg-purple-600 px-6 py-2 text-white hover:bg-purple-700 disabled:opacity-50"
             >
               {saving ? tCommon("loading") : t("buttons.saveEventSub")}
             </button>
             <button
               onClick={() => { fetchRewards(); fetchEventSubStatus(); fetchAdditionalRewards(); }}
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
