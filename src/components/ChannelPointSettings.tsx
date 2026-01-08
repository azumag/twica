"use client";

import { useState, useEffect } from "react";

interface TwitchReward {
  id: string;
  title: string;
  cost: number;
  is_enabled: boolean;
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

  useEffect(() => {
    fetchRewards();
  }, []);

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
      const response = await fetch("/api/streamer/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          streamerId,
          channelPointRewardId: selectedRewardId,
          channelPointRewardName: selectedRewardName,
        }),
      });

      if (response.ok) {
        setMessage("保存しました");
      } else {
        setMessage("保存に失敗しました");
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

  return (
    <div className="rounded-xl bg-gray-800 p-6">
      <h2 className="mb-4 text-xl font-semibold text-white">
        チャネルポイント設定
      </h2>

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

          <div className="flex items-center gap-4">
            <button
              onClick={handleSave}
              disabled={saving || !selectedRewardId}
              className="rounded-lg bg-purple-600 px-6 py-2 text-white hover:bg-purple-700 disabled:opacity-50"
            >
              {saving ? "保存中..." : "保存"}
            </button>
            <button
              onClick={fetchRewards}
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
