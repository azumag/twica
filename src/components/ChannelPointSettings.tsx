"use client";

import { useState, useEffect, useCallback } from "react";
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

interface ChannelPointSettingsProps {
  streamerId: string;
  currentRewardId: string | null;
  currentRewardName: string | null;
}

export default function ChannelPointSettings({
  streamerId,
  currentRewardId,
  currentRewardName,
}: ChannelPointSettingsProps) {
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
      const response = await fetch("/api/twitch/rewards");

      if (response.status === 403) {
        setError("チャネルポイントを使用するには、Twitchアフィリエイトまたはパートナーである必要があります。");
        setLoading(false);
        return;
      }

      if (response.status === 429) {
        const errorData = await response.json();
        setError(errorData.error || "リクエストが多すぎます。しばらく待ってから再試行してください。");
        setLoading(false);
        return;
      }

      if (!response.ok) {
        throw new Error("Failed to fetch rewards");
      }

      const data = await response.json();
      setRewards(data);
    } catch {
      setError("報酬の取得に失敗しました。再度ログインしてください。");
    } finally {
      setLoading(false);
    }
  };

  const fetchEventSubStatus = useCallback(async () => {
    try {
      const response = await fetch("/api/twitch/eventsub/subscribe");
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

  useEffect(() => {
    fetchRewards();
    fetchEventSubStatus();
  }, [fetchEventSubStatus]);

  const handleCreateReward = async () => {
    setCreating(true);
    setMessage("");

    try {
      const response = await fetch("/api/twitch/rewards", {
        method: "POST",
      });

      if (response.ok) {
        const newReward = await response.json();
        setRewards([...rewards, newReward]);
        setSelectedRewardId(newReward.id);
        setSelectedRewardName(newReward.title);
        setMessage("報酬を作成しました");
      } else if (response.status === 429) {
        const errorData = await response.json();
        setMessage(errorData.error || "リクエストが多すぎます。しばらく待ってから再試行してください。");
      } else {
        setMessage("報酬の作成に失敗しました");
      }
    } catch {
      setMessage("エラーが発生しました");
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
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          streamerId,
          channelPointRewardId: selectedRewardId,
          channelPointRewardName: selectedRewardName,
        }),
      });

      if (settingsResponse.status === 429) {
        const errorData = await settingsResponse.json();
        setMessage(errorData.error || "リクエストが多すぎます。しばらく待ってから再試行してください。");
        return;
      }

      if (!settingsResponse.ok) {
        setMessage("設定の保存に失敗しました");
        return;
      }

      // Subscribe to EventSub
      const eventSubResponse = await fetch("/api/twitch/eventsub/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rewardId: selectedRewardId,
        }),
      });

      if (eventSubResponse.ok) {
        setMessage("保存しました（EventSub登録完了）");
        setEventSubStatus("pending");
        // Refresh status
        await fetchEventSubStatus();
      } else if (eventSubResponse.status === 429) {
        const errorData = await eventSubResponse.json();
        setMessage(errorData.error || "リクエストが多すぎます。しばらく待ってから再試行してください。");
      } else {
        const errorData = await eventSubResponse.json();
        logger.error("EventSub error:", errorData);
        setMessage("設定は保存しましたが、EventSub登録に失敗しました。URLが外部からアクセス可能か確認してください。");
        setEventSubStatus("error");
      }
    } catch {
      setMessage("エラーが発生しました");
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
            接続中
          </span>
        );
      case "pending":
        return (
          <span className="inline-flex items-center gap-1 rounded-full bg-yellow-500/20 px-2 py-1 text-xs text-yellow-400">
            <span className="h-2 w-2 rounded-full bg-yellow-500"></span>
            確認中
          </span>
        );
      case "error":
        return (
          <span className="inline-flex items-center gap-1 rounded-full bg-red-500/20 px-2 py-1 text-xs text-red-400">
            <span className="h-2 w-2 rounded-full bg-red-500"></span>
            エラー
          </span>
        );
      default:
        return (
          <span className="inline-flex items-center gap-1 rounded-full bg-gray-500/20 px-2 py-1 text-xs text-gray-400">
            <span className="h-2 w-2 rounded-full bg-gray-500"></span>
            未設定
          </span>
        );
    }
  };

  return (
    <div className="rounded-xl bg-gray-800 p-6">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-xl font-semibold text-white">
          チャネルポイント設定
        </h2>
        {getEventSubStatusBadge()}
      </div>

      {error ? (
        <div className="rounded-lg bg-red-500/20 p-4 text-red-300">
          {error}
        </div>
      ) : loading ? (
        <div className="text-gray-400">読み込み中...</div>
      ) : (
        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-sm text-gray-300">
              使用する報酬を選択
            </label>
            <select
              value={selectedRewardId}
              onChange={handleRewardSelect}
              className="w-full rounded-lg bg-gray-700 px-4 py-2 text-gray-200"
            >
              <option value="">-- 報酬を選択 --</option>
              {rewards.map((reward) => (
                <option key={reward.id} value={reward.id}>
                  {reward.title} ({reward.cost} ポイント)
                  {!reward.is_enabled && " [無効]"}
                </option>
              ))}
            </select>
          </div>

          {rewards.length === 0 && (
            <div className="rounded-lg bg-gray-700 p-4">
              <p className="mb-3 text-sm text-gray-400">
                チャネルポイント報酬がありません。新しく作成しますか？
              </p>
              <button
                onClick={handleCreateReward}
                disabled={creating}
                className="rounded-lg bg-purple-600 px-4 py-2 text-sm text-white hover:bg-purple-700 disabled:opacity-50"
              >
                {creating ? "作成中..." : "TwiCa用報酬を作成（100ポイント）"}
              </button>
            </div>
          )}

          {selectedRewardId && (
            <div className="rounded-lg bg-gray-700 p-3">
              <p className="text-sm text-gray-400">
                選択中: <span className="text-white">{selectedRewardName}</span>
              </p>
              <p className="mt-1 text-xs text-gray-500">
                ID: {selectedRewardId}
              </p>
            </div>
          )}

          {/* EventSub Info */}
          <div className="rounded-lg bg-gray-700/50 p-4">
            <h3 className="mb-2 text-sm font-medium text-gray-300">EventSub ステータス</h3>
            {subscriptions.length > 0 ? (
              <div className="space-y-1">
                {subscriptions.map((sub) => (
                  <div key={sub.id} className="flex items-center justify-between text-xs">
                    <span className="text-gray-400">
                      {sub.condition.reward_id ? `報酬ID: ${sub.condition.reward_id.slice(0, 8)}...` : "全報酬"}
                    </span>
                    <span className={sub.status === "enabled" ? "text-green-400" : "text-yellow-400"}>
                      {sub.status}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-gray-500">
                EventSubサブスクリプションがありません。保存ボタンを押して登録してください。
              </p>
            )}
            <p className="mt-2 text-xs text-gray-500">
              ※ ローカル環境ではngrokなどのトンネルが必要です
            </p>
          </div>

          <div className="flex items-center gap-4">
            <button
              onClick={handleSave}
              disabled={saving || !selectedRewardId}
              className="rounded-lg bg-purple-600 px-6 py-2 text-white hover:bg-purple-700 disabled:opacity-50"
            >
              {saving ? "保存中..." : "保存 & EventSub登録"}
            </button>
            <button
              onClick={() => { fetchRewards(); fetchEventSubStatus(); }}
              className="rounded-lg border border-gray-600 px-4 py-2 text-gray-300 hover:bg-gray-700"
            >
              更新
            </button>
            {message && (
              <span
                className={
                  message.includes("失敗") || message.includes("エラー")
                    ? "text-red-400"
                    : "text-green-400"
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
