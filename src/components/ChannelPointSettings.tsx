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

// Additional reward stored in DB
// DBに保存された追加報酬
interface AdditionalReward {
  id: string;
  reward_id: string;
  reward_name: string | null;
  created_at: string;
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
  // disconnecting: 設定解除処理中かどうかを管理
  const [disconnecting, setDisconnecting] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [eventSubStatus, setEventSubStatus] = useState<"none" | "pending" | "active" | "error">("none");
  const [subscriptions, setSubscriptions] = useState<EventSubSubscription[]>([]);
  // Additional rewards state
  // 追加報酬の状態管理
  const [additionalRewards, setAdditionalRewards] = useState<AdditionalReward[]>([]);
  const [addingAdditional, setAddingAdditional] = useState(false);
  const [selectedAdditionalRewardId, setSelectedAdditionalRewardId] = useState("");

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

  // Fetch additional rewards from DB
  // DBから追加報酬を取得
  const fetchAdditionalRewards = useCallback(async () => {
    try {
      const response = await fetch("/api/streamer/additional-rewards", {
        credentials: "include",
      });
      if (response.ok) {
        const data = await response.json();
        setAdditionalRewards(data);
        logger.info("[AdditionalRewards] Fetched additional rewards", { count: data.length });
      }
    } catch {
      logger.error("Failed to fetch additional rewards");
    }
  }, []);

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

        // Check for failed subscriptions
        // 失敗したサブスクリプションをチェック
        const failedStatuses = [
          "webhook_callback_verification_failed",
          "notification_failures_exceeded",
          "authorization_revoked",
        ];
        const hasFailedSub = subs.some(
          (sub: EventSubSubscription) => failedStatuses.includes(sub.status)
        );

        logger.info("[EventSub] Status check", { activeSub: !!activeSub, hasFailedSub, rewardIdToCheck, subsLength: subs.length });

        if (activeSub) {
          logger.info("[EventSub] Setting status to ACTIVE");
          setEventSubStatus("active");
        } else if (hasFailedSub) {
          logger.info("[EventSub] Setting status to ERROR (failed subscription found)");
          setEventSubStatus("error");
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
    // Fetch additional rewards if main reward is set
    // メイン報酬が設定されている場合は追加報酬も取得
    if (currentRewardId) {
      fetchAdditionalRewards();
    }
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

  /**
   * Add an additional reward
   * 追加報酬を登録する
   */
  const handleAddAdditionalReward = async () => {
    if (!selectedAdditionalRewardId) return;

    setAddingAdditional(true);
    setMessage("");

    try {
      const selectedReward = rewards.find((r) => r.id === selectedAdditionalRewardId);
      const rewardName = selectedReward?.title || "";

      // 1. Register EventSub subscription for the additional reward
      // 追加報酬用のEventSubサブスクリプションを登録
      const eventSubResponse = await fetch("/api/twitch/eventsub/subscribe", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rewardId: selectedAdditionalRewardId,
          isAdditional: true,
        }),
      });

      const eventSubData = await eventSubResponse.json();

      if (!eventSubData.success && !eventSubData.warning) {
        setMessage(eventSubData.error || t("additionalRewards.addFailed"));
        setAddingAdditional(false);
        return;
      }

      // 2. Save to DB
      // DBに保存
      const dbResponse = await fetch("/api/streamer/additional-rewards", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rewardId: selectedAdditionalRewardId,
          rewardName: rewardName,
        }),
      });

      const dbData = await dbResponse.json();

      if (!dbResponse.ok) {
        setMessage(dbData.error || t("additionalRewards.addFailed"));
        setAddingAdditional(false);
        return;
      }

      // 3. Update state
      // 状態を更新
      setMessage(t("additionalRewards.addSuccess"));
      setSelectedAdditionalRewardId("");
      await fetchAdditionalRewards();
      await fetchEventSubStatus(selectedRewardId);

    } catch {
      setMessage(t("messages.errorOccurred"));
    } finally {
      setAddingAdditional(false);
    }
  };

  /**
   * Remove an additional reward
   * 追加報酬を削除する
   */
  const handleRemoveAdditionalReward = async (rewardId: string) => {
    if (!window.confirm(t("additionalRewards.removeConfirm"))) {
      return;
    }

    setMessage("");

    try {
      // 1. Delete EventSub subscription for this reward
      // この報酬のEventSubサブスクリプションを削除
      await fetch(`/api/twitch/eventsub/subscribe?rewardId=${rewardId}`, {
        method: "DELETE",
        credentials: "include",
      });

      // 2. Delete from DB
      // DBから削除
      const dbResponse = await fetch(`/api/streamer/additional-rewards?rewardId=${rewardId}`, {
        method: "DELETE",
        credentials: "include",
      });

      if (!dbResponse.ok) {
        const dbData = await dbResponse.json();
        setMessage(dbData.error || t("additionalRewards.removeFailed"));
        return;
      }

      // 3. Update state
      // 状態を更新
      setMessage(t("additionalRewards.removeSuccess"));
      await fetchAdditionalRewards();
      await fetchEventSubStatus(selectedRewardId);

    } catch {
      setMessage(t("messages.errorOccurred"));
    }
  };

  /**
   * チャネルポイント連携を解除する
   * EventSubサブスクリプションを削除し、DBの設定をクリアする
   * Disconnect channel point integration by removing EventSub subscriptions and clearing DB settings
   */
  const handleDisconnect = async () => {
    // 確認ダイアログを表示
    // Show confirmation dialog before proceeding with disconnection
    if (!window.confirm(t("messages2.disconnectConfirm"))) {
      return;
    }

    setDisconnecting(true);
    setMessage("");

    try {
      // 1. EventSubサブスクリプションを全て削除
      // Delete all EventSub subscriptions for this broadcaster using the proper subscribe endpoint
      const eventSubResponse = await fetch("/api/twitch/eventsub/subscribe", {
        method: "DELETE",
        credentials: "include",
      });

      if (!eventSubResponse.ok) {
        logger.error("Failed to delete EventSub subscriptions", await eventSubResponse.json());
        // EventSub削除に失敗しても、DB設定のクリアは続行する
        // Continue to clear DB settings even if EventSub deletion fails
      }

      // 2. 追加報酬をDBから全て削除
      // Delete all additional rewards from DB
      await fetch("/api/streamer/additional-rewards?deleteAll=true", {
        method: "DELETE",
        credentials: "include",
      });

      // 3. DB設定をクリア（channel_point_reward_id と channel_point_reward_name を null に）
      // Clear DB settings by setting channel_point_reward_id and channel_point_reward_name to null
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

      if (!settingsResponse.ok) {
        const errorData = await settingsResponse.json();
        setMessage(errorData.error || t("messages2.disconnectFailed"));
        return;
      }

      // 4. UIの状態をリセット
      // Reset UI state after successful disconnection
      setSelectedRewardId("");
      setSelectedRewardName("");
      setEventSubStatus("none");
      setSubscriptions([]);
      setAdditionalRewards([]);
      setMessage(t("messages2.disconnectSuccess"));

    } catch (err) {
      logger.error("Failed to disconnect:", err);
      setMessage(t("messages2.disconnectFailed"));
    } finally {
      setDisconnecting(false);
    }
  };

  /**
   * Get reward name by reward ID
   * 報酬IDから報酬名を取得するヘルパー関数
   * Checks: 1) Main reward, 2) Twitch rewards list, 3) Additional rewards DB
   */
  const getRewardNameById = (rewardId: string): string | null => {
    // Check if it's the main reward
    // メイン報酬かチェック
    if (rewardId === selectedRewardId && selectedRewardName) {
      return selectedRewardName;
    }
    // Check in Twitch rewards list
    // Twitch報酬リストをチェック
    const twitchReward = rewards.find((r) => r.id === rewardId);
    if (twitchReward) {
      return twitchReward.title;
    }
    // Check in additional rewards from DB
    // DBの追加報酬をチェック
    const additionalReward = additionalRewards.find((r) => r.reward_id === rewardId);
    if (additionalReward?.reward_name) {
      return additionalReward.reward_name;
    }
    return null;
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
                         {sub.condition.reward_id ? (
                           <>
                             {/* Display reward name if available, otherwise show truncated ID */}
                             {/* 報酬名があれば表示、なければ短縮IDを表示 */}
                             {getRewardNameById(sub.condition.reward_id) || `${t("form.rewardId")} ${sub.condition.reward_id.slice(0, 8)}...`}
                             <span className="ml-1 text-gray-500">
                               ({sub.condition.reward_id.slice(0, 8)}...)
                             </span>
                           </>
                         ) : t("form.allRewards")}
                       </span>
                       <span className={
                         sub.status === "enabled"
                           ? "text-green-400"
                           : ["webhook_callback_verification_failed", "notification_failures_exceeded", "authorization_revoked"].includes(sub.status)
                             ? "text-red-400"
                             : "text-yellow-400"
                       }>
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
                     {/* Explanation for failed verification status */}
                     {/* 検証失敗状態の説明 */}
                     {sub.status === "webhook_callback_verification_failed" && (
                       <div className="mt-1 rounded bg-red-500/10 p-2 text-xs text-red-300">
                         <p className="font-medium">Webhook検証失敗</p>
                         <p className="mt-1 text-red-400/80">
                           TwitchからのWebhook検証に失敗しました。
                         </p>
                         <ul className="mt-1 list-inside list-disc text-red-400/70">
                           <li>サーバーが外部からアクセス可能か確認してください</li>
                           <li>「保存 & EventSub登録」ボタンで再登録してください</li>
                         </ul>
                       </div>
                     )}
                     {/* Explanation for notification failures exceeded */}
                     {/* 通知失敗超過の説明 */}
                     {sub.status === "notification_failures_exceeded" && (
                       <div className="mt-1 rounded bg-red-500/10 p-2 text-xs text-red-300">
                         <p className="font-medium">通知失敗が多発</p>
                         <p className="mt-1 text-red-400/80">
                           Twitchからの通知が何度も失敗したため、サブスクリプションが無効化されました。
                         </p>
                         <ul className="mt-1 list-inside list-disc text-red-400/70">
                           <li>サーバーの状態を確認してください</li>
                           <li>「保存 & EventSub登録」ボタンで再登録してください</li>
                         </ul>
                       </div>
                     )}
                     {/* Explanation for authorization revoked */}
                     {/* 認証取り消しの説明 */}
                     {sub.status === "authorization_revoked" && (
                       <div className="mt-1 rounded bg-red-500/10 p-2 text-xs text-red-300">
                         <p className="font-medium">認証が取り消されました</p>
                         <p className="mt-1 text-red-400/80">
                           Twitchの認証が取り消されたため、サブスクリプションが無効化されました。
                         </p>
                         <ul className="mt-1 list-inside list-disc text-red-400/70">
                           <li>再度ログインしてください</li>
                           <li>「保存 & EventSub登録」ボタンで再登録してください</li>
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

           {/* Additional Rewards Section - Only shown when main reward is active */}
           {/* 追加報酬セクション - メイン報酬がアクティブな場合のみ表示 */}
           {selectedRewardId && eventSubStatus === "active" && (
             <div className="rounded-lg bg-gray-700/50 p-4">
               <h3 className="mb-2 text-sm font-medium text-gray-300">
                 {t("additionalRewards.title")}
               </h3>
               <p className="mb-3 text-xs text-gray-400">
                 {t("additionalRewards.description")}
               </p>

               {/* List of additional rewards */}
               {/* 追加報酬一覧 */}
               {additionalRewards.length > 0 && (
                 <div className="mb-3 space-y-2">
                   {additionalRewards.map((reward) => (
                     <div
                       key={reward.id}
                       className="flex items-center justify-between rounded bg-gray-600/50 px-3 py-2"
                     >
                       <div>
                         <span className="text-sm text-gray-200">
                           {reward.reward_name || reward.reward_id.slice(0, 8) + "..."}
                         </span>
                         <span className="ml-2 text-xs text-gray-400">
                           ({reward.reward_id.slice(0, 8)}...)
                         </span>
                       </div>
                       <button
                         onClick={() => handleRemoveAdditionalReward(reward.reward_id)}
                         className="text-xs text-red-400 hover:text-red-300"
                       >
                         {t("additionalRewards.remove")}
                       </button>
                     </div>
                   ))}
                 </div>
               )}

               {/* Add new additional reward */}
               {/* 新しい追加報酬を追加 */}
               <div className="flex items-center gap-2">
                 <select
                   value={selectedAdditionalRewardId}
                   onChange={(e) => setSelectedAdditionalRewardId(e.target.value)}
                   className="flex-1 rounded-lg bg-gray-600 px-3 py-2 text-sm text-gray-200"
                 >
                   <option value="">{t("additionalRewards.selectToAdd")}</option>
                   {rewards
                     .filter((r) =>
                       // Exclude main reward and already added additional rewards
                       // メイン報酬と既に追加済みの追加報酬を除外
                       r.id !== selectedRewardId &&
                       !additionalRewards.some((ar) => ar.reward_id === r.id)
                     )
                     .map((reward) => (
                       <option key={reward.id} value={reward.id}>
                         {reward.title} ({reward.cost} {t("options.points")})
                         {!reward.is_enabled && t("options.disabled")}
                       </option>
                     ))}
                 </select>
                 <button
                   onClick={handleAddAdditionalReward}
                   disabled={addingAdditional || !selectedAdditionalRewardId}
                   className="rounded-lg bg-purple-600 px-4 py-2 text-sm text-white hover:bg-purple-700 disabled:opacity-50"
                 >
                   {addingAdditional ? tCommon("loading") : tCommon("add")}
                 </button>
               </div>
             </div>
           )}

           <div className="flex flex-wrap items-center gap-4">
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
             {/* 設定解除ボタン: EventSubが設定されている場合のみ表示 */}
             {/* Disconnect button: Only shown when EventSub is configured */}
             {(eventSubStatus === "active" || eventSubStatus === "pending" || subscriptions.length > 0) && (
               <button
                 onClick={handleDisconnect}
                 disabled={disconnecting}
                 className="rounded-lg border border-red-600 px-4 py-2 text-red-400 hover:bg-red-600/20 disabled:opacity-50"
               >
                 {disconnecting ? t("buttons.disconnecting") : t("buttons.disconnect")}
               </button>
             )}
              {message && (
                <span
                  className={
                    // Check if message is a success message by comparing with translated values
                    // 翻訳された値と比較して成功メッセージかどうかを確認
                    [
                      t("messages.rewardCreated"),
                      t("messages.saveSuccess"),
                      t("messages2.disconnectSuccess"),
                      t("additionalRewards.addSuccess"),
                      t("additionalRewards.removeSuccess"),
                    ].includes(message)
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
