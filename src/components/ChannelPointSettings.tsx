"use client";

import { useState } from "react";

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
  const [rewardName, setRewardName] = useState(currentRewardName || "");
  const [rewardId, setRewardId] = useState(currentRewardId || "");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  const handleSave = async () => {
    setSaving(true);
    setMessage("");

    try {
      const response = await fetch("/api/streamer/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          streamerId,
          channelPointRewardId: rewardId,
          channelPointRewardName: rewardName,
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

  return (
    <div className="rounded-xl bg-gray-800 p-6">
      <h2 className="mb-4 text-xl font-semibold text-white">
        チャネルポイント設定
      </h2>
      <p className="mb-4 text-sm text-gray-400">
        Twitchで作成したチャネルポイント報酬の情報を入力してください
      </p>
      <div className="space-y-4">
        <div>
          <label className="mb-1 block text-sm text-gray-300">報酬名</label>
          <input
            type="text"
            value={rewardName}
            onChange={(e) => setRewardName(e.target.value)}
            placeholder="例: カードガチャを引く"
            className="w-full rounded-lg bg-gray-700 px-4 py-2 text-gray-200 placeholder-gray-500"
          />
        </div>
        <div>
          <label className="mb-1 block text-sm text-gray-300">報酬ID</label>
          <input
            type="text"
            value={rewardId}
            onChange={(e) => setRewardId(e.target.value)}
            placeholder="報酬のID"
            className="w-full rounded-lg bg-gray-700 px-4 py-2 text-gray-200 placeholder-gray-500"
          />
          <p className="mt-1 text-xs text-gray-500">
            Twitch APIまたは管理画面から取得できます
          </p>
        </div>
        <div className="flex items-center gap-4">
          <button
            onClick={handleSave}
            disabled={saving}
            className="rounded-lg bg-purple-600 px-6 py-2 text-white hover:bg-purple-700 disabled:opacity-50"
          >
            {saving ? "保存中..." : "保存"}
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
    </div>
  );
}
