"use client";

import { useState, useEffect, useCallback } from "react";
import { logger } from "@/lib/logger";
import { UI_STRINGS } from "@/lib/constants";

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
        setError(UI_STRINGS.CHANNEL_POINT_SETTINGS.MESSAGES.AFFILIATE_REQUIRED);
        setLoading(false);
        return;
      }

      if (response.status === 429) {
        const errorData = await response.json();
        setError(errorData.error || UI_STRINGS.CHANNEL_POINT_SETTINGS.MESSAGES.RATE_LIMIT);
        setLoading(false);
        return;
      }

      if (!response.ok) {
        throw new Error("Failed to fetch rewards");
      }

      const data = await response.json();
      setRewards(data);
    } catch {
      setError(UI_STRINGS.CHANNEL_POINT_SETTINGS.MESSAGES.FETCH_FAILED);
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
        setMessage(UI_STRINGS.CHANNEL_POINT_SETTINGS.MESSAGES.REWARD_CREATED);
      } else if (response.status === 429) {
        const errorData = await response.json();
        setMessage(errorData.error || UI_STRINGS.CHANNEL_POINT_SETTINGS.MESSAGES.RATE_LIMIT);
      } else {
        setMessage(UI_STRINGS.CHANNEL_POINT_SETTINGS.MESSAGES.CREATE_REWARD_FAILED);
      }
    } catch {
      setMessage(UI_STRINGS.CHANNEL_POINT_SETTINGS.MESSAGES.ERROR_OCCURRED);
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
        setMessage(errorData.error || UI_STRINGS.CHANNEL_POINT_SETTINGS.MESSAGES.RATE_LIMIT);
        return;
      }

      if (!settingsResponse.ok) {
        setMessage(UI_STRINGS.CHANNEL_POINT_SETTINGS.MESSAGES.SAVE_FAILED);
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
        setMessage(UI_STRINGS.CHANNEL_POINT_SETTINGS.MESSAGES.SAVE_SUCCESS);
        setEventSubStatus("pending");
        // Refresh status
        await fetchEventSubStatus();
      } else if (eventSubResponse.status === 429) {
        const errorData = await eventSubResponse.json();
        setMessage(errorData.error || UI_STRINGS.CHANNEL_POINT_SETTINGS.MESSAGES.RATE_LIMIT);
      } else {
        const errorData = await eventSubResponse.json();
        logger.error("EventSub error:", errorData);
        setMessage(UI_STRINGS.CHANNEL_POINT_SETTINGS.MESSAGES.EVENTSUB_FAILED);
        setEventSubStatus("error");
      }
    } catch {
      setMessage(UI_STRINGS.CHANNEL_POINT_SETTINGS.MESSAGES.ERROR_OCCURRED);
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
            {UI_STRINGS.CHANNEL_POINT_SETTINGS.STATUS.ACTIVE}
          </span>
        );
      case "pending":
        return (
          <span className="inline-flex items-center gap-1 rounded-full bg-yellow-500/20 px-2 py-1 text-xs text-yellow-400">
            <span className="h-2 w-2 rounded-full bg-yellow-500"></span>
            {UI_STRINGS.CHANNEL_POINT_SETTINGS.STATUS.PENDING}
          </span>
        );
      case "error":
        return (
          <span className="inline-flex items-center gap-1 rounded-full bg-red-500/20 px-2 py-1 text-xs text-red-400">
            <span className="h-2 w-2 rounded-full bg-red-500"></span>
            {UI_STRINGS.CHANNEL_POINT_SETTINGS.STATUS.ERROR}
          </span>
        );
      default:
        return (
          <span className="inline-flex items-center gap-1 rounded-full bg-gray-500/20 px-2 py-1 text-xs text-gray-400">
            <span className="h-2 w-2 rounded-full bg-gray-500"></span>
            {UI_STRINGS.CHANNEL_POINT_SETTINGS.STATUS.NONE}
          </span>
        );
    }
  };

  return (
    <div className="rounded-xl bg-gray-800 p-6">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-xl font-semibold text-white">
          {UI_STRINGS.CHANNEL_POINT_SETTINGS.TITLE}
        </h2>
        {getEventSubStatusBadge()}
      </div>

       {error ? (
         <div className="rounded-lg bg-red-500/20 p-4 text-red-300">
           {error}
         </div>
       ) : loading ? (
         <div className="text-gray-400">{UI_STRINGS.AUTH.LOADING}</div>
       ) : (
         <div className="space-y-4">
           <div>
             <label className="mb-1 block text-sm text-gray-300">
               {UI_STRINGS.CHANNEL_POINT_SETTINGS.FORM_LABELS.SELECT_REWARD}
             </label>
             <select
               value={selectedRewardId}
               onChange={handleRewardSelect}
               className="w-full rounded-lg bg-gray-700 px-4 py-2 text-gray-200"
             >
               <option value="">{UI_STRINGS.CHANNEL_POINT_SETTINGS.OPTIONS.SELECT_REWARD}</option>
               {rewards.map((reward) => (
                 <option key={reward.id} value={reward.id}>
                   {reward.title} ({reward.cost} {UI_STRINGS.CHANNEL_POINT_SETTINGS.OPTIONS.POINTS})
                   {!reward.is_enabled && UI_STRINGS.CHANNEL_POINT_SETTINGS.OPTIONS.DISABLED}
                 </option>
               ))}
             </select>
           </div>

           {rewards.length === 0 && (
             <div className="rounded-lg bg-gray-700 p-4">
               <p className="mb-3 text-sm text-gray-400">
                 {UI_STRINGS.CHANNEL_POINT_SETTINGS.FORM_LABELS.NO_REWARDS}
               </p>
               <button
                 onClick={handleCreateReward}
                 disabled={creating}
                 className="rounded-lg bg-purple-600 px-4 py-2 text-sm text-white hover:bg-purple-700 disabled:opacity-50"
               >
                 {creating ? UI_STRINGS.CHANNEL_POINT_SETTINGS.BUTTONS.CREATING : UI_STRINGS.CHANNEL_POINT_SETTINGS.BUTTONS.CREATE_REWARD}
               </button>
             </div>
           )}

           {selectedRewardId && (
             <div className="rounded-lg bg-gray-700 p-3">
               <p className="text-sm text-gray-400">
                 {UI_STRINGS.CHANNEL_POINT_SETTINGS.FORM_LABELS.SELECTED} <span className="text-white">{selectedRewardName}</span>
               </p>
               <p className="mt-1 text-xs text-gray-500">
                 {UI_STRINGS.CHANNEL_POINT_SETTINGS.FORM_LABELS.ID} {selectedRewardId}
               </p>
             </div>
           )}

           {/* EventSub Info */}
           <div className="rounded-lg bg-gray-700/50 p-4">
             <h3 className="mb-2 text-sm font-medium text-gray-300">{UI_STRINGS.CHANNEL_POINT_SETTINGS.FORM_LABELS.EVENTSUB_STATUS}</h3>
             {subscriptions.length > 0 ? (
               <div className="space-y-1">
                 {subscriptions.map((sub) => (
                   <div key={sub.id} className="flex items-center justify-between text-xs">
                     <span className="text-gray-400">
                       {sub.condition.reward_id ? `${UI_STRINGS.CHANNEL_POINT_SETTINGS.FORM_LABELS.REWARD_ID} ${sub.condition.reward_id.slice(0, 8)}...` : UI_STRINGS.CHANNEL_POINT_SETTINGS.FORM_LABELS.ALL_REWARDS}
                     </span>
                     <span className={sub.status === "enabled" ? "text-green-400" : "text-yellow-400"}>
                       {sub.status}
                     </span>
                   </div>
                 ))}
               </div>
             ) : (
               <p className="text-xs text-gray-500">
                 {UI_STRINGS.CHANNEL_POINT_SETTINGS.FORM_LABELS.NO_SUBSCRIPTIONS}
               </p>
             )}
             <p className="mt-2 text-xs text-gray-500">
               {UI_STRINGS.CHANNEL_POINT_SETTINGS.FORM_LABELS.LOCAL_TUNNEL_NOTE}
             </p>
           </div>

           <div className="flex items-center gap-4">
             <button
               onClick={handleSave}
               disabled={saving || !selectedRewardId}
               className="rounded-lg bg-purple-600 px-6 py-2 text-white hover:bg-purple-700 disabled:opacity-50"
             >
               {saving ? UI_STRINGS.CHANNEL_POINT_SETTINGS.BUTTONS.SAVING : UI_STRINGS.CHANNEL_POINT_SETTINGS.BUTTONS.SAVE}
             </button>
             <button
               onClick={() => { fetchRewards(); fetchEventSubStatus(); }}
               className="rounded-lg border border-gray-600 px-4 py-2 text-gray-300 hover:bg-gray-700"
             >
               {UI_STRINGS.CHANNEL_POINT_SETTINGS.BUTTONS.REFRESH}
             </button>
              {message && (
                <span
                  className={
                    // @ts-expect-error - SUCCESS_MESSAGES contains string literals
                    UI_STRINGS.CHANNEL_POINT_SETTINGS.SUCCESS_MESSAGES.includes(message)
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
