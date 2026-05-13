export interface EventSubSubscriptionForStatus {
  id: string;
  status: string;
  type: string;
  condition: {
    broadcaster_user_id?: string;
    reward_id?: string;
    to_broadcaster_user_id?: string;
  };
  transport?: {
    callback?: string;
  };
  debug?: {
    expectedCallbackUrl: string;
    callbackMatch: boolean;
  };
}

export type EventSubStatus = "none" | "pending" | "active" | "error";

export const CHANNEL_POINTS_EVENTSUB_TYPE = "channel.channel_points_custom_reward_redemption.add";
export const RAID_EVENTSUB_TYPE = "channel.raid";
export const FAILED_EVENTSUB_STATUSES = [
  "webhook_callback_verification_failed",
  "notification_failures_exceeded",
  "authorization_revoked",
];

const matchesExpectedCallback = (sub: EventSubSubscriptionForStatus) => sub.debug?.callbackMatch ?? true;

export function deriveEventSubStatus(
  subs: EventSubSubscriptionForStatus[],
  rewardIdToCheck: string,
): { rewardStatus: EventSubStatus; raidStatus: EventSubStatus } {
  const rewardSubscriptions = subs.filter(
    (sub) => sub.type === CHANNEL_POINTS_EVENTSUB_TYPE && matchesExpectedCallback(sub)
  );
  const raidSubscriptions = subs.filter(
    (sub) => sub.type === RAID_EVENTSUB_TYPE && matchesExpectedCallback(sub)
  );

  const hasActiveRewardSub = rewardSubscriptions.some(
    (sub) => sub.status === "enabled" && sub.condition.reward_id === rewardIdToCheck
  );
  const hasFailedRewardSub = rewardSubscriptions.some(
    (sub) => FAILED_EVENTSUB_STATUSES.includes(sub.status)
  );
  const hasActiveRaidSub = raidSubscriptions.some((sub) => sub.status === "enabled");
  const hasFailedRaidSub = raidSubscriptions.some(
    (sub) => FAILED_EVENTSUB_STATUSES.includes(sub.status)
  );

  return {
    rewardStatus: hasActiveRewardSub
      ? "active"
      : hasFailedRewardSub
        ? "error"
        : rewardSubscriptions.length > 0
          ? "pending"
          : "none",
    raidStatus: hasActiveRaidSub
      ? "active"
      : hasFailedRaidSub
        ? "error"
        : raidSubscriptions.length > 0
          ? "pending"
          : "none",
  };
}
