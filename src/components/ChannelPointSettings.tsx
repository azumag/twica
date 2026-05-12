"use client";

import { useState, useEffect, useCallback } from "react";
import { useTranslations } from "next-intl";
import { logger } from "@/lib/logger";
import { CHANNEL_POINT_SCOPES } from "@/lib/twitch/scopes";


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
  draw_count: number;
  is_raid_limited: boolean;
  created_at: string;
}

interface EventSubSubscription {
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

type EventSubStatus = "none" | "pending" | "active" | "error";

const CHANNEL_POINTS_EVENTSUB_TYPE = "channel.channel_points_custom_reward_redemption.add";
const RAID_EVENTSUB_TYPE = "channel.raid";
const FAILED_EVENTSUB_STATUSES = [
  "webhook_callback_verification_failed",
  "notification_failures_exceeded",
  "authorization_revoked",
];

const matchesExpectedCallback = (sub: EventSubSubscription) => sub.debug?.callbackMatch ?? true;

const getRaidSubscriptionWarning = (data: unknown): string => {
  const raidSubscription = (data as { raidSubscription?: { warning?: unknown } })?.raidSubscription;
  return typeof raidSubscription?.warning === "string" ? raidSubscription.warning : "";
};

const getRaidSubscriptionStatus = (data: unknown): EventSubStatus | null => {
  const status = (data as { raidSubscription?: { status?: unknown } })?.raidSubscription?.status;
  return status === "none" || status === "pending" || status === "active" || status === "error"
    ? status
    : null;
};

export function deriveEventSubStatus(
  subs: EventSubSubscription[],
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
  const [eventSubStatus, setEventSubStatus] = useState<EventSubStatus>("none");
  const [raidEventSubStatus, setRaidEventSubStatus] = useState<EventSubStatus>("none");
  const [raidEventSubWarning, setRaidEventSubWarning] = useState("");
  const [subscriptions, setSubscriptions] = useState<EventSubSubscription[]>([]);
  // チャネルポイント用スコープ不足でstep-up再認証が必要かどうか
  // Whether step-up reauth is needed because channel point scopes are missing
  const [needsReauth, setNeedsReauth] = useState(false);
  const [reauthorizing, setReauthorizing] = useState(false);
  // Additional rewards state
  // 追加報酬の状態管理
  const [additionalRewards, setAdditionalRewards] = useState<AdditionalReward[]>([]);
  const [addingAdditional, setAddingAdditional] = useState(false);
  const [selectedAdditionalRewardId, setSelectedAdditionalRewardId] = useState("");
  const [additionalDrawCount, setAdditionalDrawCount] = useState(1);
  const [raidGiftDrawCount, setRaidGiftDrawCount] = useState(0);
  const [updatingRaidGift, setUpdatingRaidGift] = useState(false);
  // Track if registration failed (webhook unreachable)
  // 登録失敗を追跡（Webhookに到達できなかった場合）
  const [registrationFailed, setRegistrationFailed] = useState(false);
  // Track the saved main reward ID (to detect changes for cleanup)
  // 保存済みのメイン報酬IDを追跡（変更検出とクリーンアップ用）
  const [savedMainRewardId, setSavedMainRewardId] = useState(currentRewardId || "");

  // チャネルポイント系スコープが付与済みか事前確認する。
  // 初回ログインではこれらのスコープを要求しないため、
  // 連携未設定のユーザーはここで step-up 再認証の導線に誘導される。
  // Pre-check Channel Points scope grant. Initial login omits these scopes,
  // so users who haven't opted in are redirected to step-up reauth via the CTA.
  const checkChannelPointScope = useCallback(async (): Promise<boolean> => {
    try {
      const response = await fetch(
        `/api/auth/check-scope?scope=${encodeURIComponent(
          "channel:read:redemptions"
        )}`,
        { credentials: "include" }
      );
      if (!response.ok) {
        // 一時的な障害（rate limit等）: reauth CTAを出さずrewards APIに任せる。
        // Transient failure (e.g. rate limit): fall through to rewards API.
        return true;
      }
      const data = await response.json();
      return Boolean(data.hasScope);
    } catch (err) {
      logger.error("Failed to check channel point scope:", err);
      return true;
    }
  }, []);

  const fetchRewards = async () => {
    setLoading(true);
    setError("");

    try {
      // スコープ未付与なら rewards API を呼ぶ前に CTA へ切替える。
      // これにより Twitch 401 の汎用エラーに埋もれないようにする。
      // Short-circuit to the reauth CTA before calling the rewards API when
      // scopes are missing, so users never see a generic 401 error instead.
      const hasScope = await checkChannelPointScope();
      if (!hasScope) {
        setNeedsReauth(true);
        setLoading(false);
        return;
      }

      const response = await fetch("/api/twitch/rewards", {
        credentials: "include",
      });

      if (response.status === 401) {
        const errorData = await response.json();
        // requiresReauth はトークン自体が失われたケース。
        // スコープ不足は事前チェックで拾うため、ここではログイン誘導のみ。
        // requiresReauth here means the token itself is gone; scope gaps are
        // already handled by the pre-check above.
        if (errorData.requiresReauth) {
          setNeedsReauth(true);
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
      // キャッシュを無効化して常に最新のデータを取得
      // Disable cache to always fetch fresh data after additions/deletions
      const response = await fetch("/api/streamer/additional-rewards", {
        credentials: "include",
        cache: "no-store",
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

  const fetchRaidGachaStatus = useCallback(async () => {
    try {
      const response = await fetch("/api/streamer/raid-gacha", {
        credentials: "include",
        cache: "no-store",
      });
      if (response.ok) {
        const data = await response.json();
        setRaidGiftDrawCount(Math.min(10, Math.max(0, Number(data.drawCount ?? 0))));
      }
    } catch {
      logger.error("Failed to fetch raid gacha status");
    }
  }, []);

  const updateRaidGiftSettings = async () => {
    setUpdatingRaidGift(true);
    setMessage("");

    try {
      const response = await fetch("/api/streamer/raid-gacha", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ drawCount: raidGiftDrawCount }),
      });
      const data = await response.json();

      if (!response.ok) {
        setMessage(data.error || t("additionalRewards.raidStatusFailed"));
        return;
      }

      setRaidGiftDrawCount(Math.min(10, Math.max(0, Number(data.drawCount ?? 0))));
      setMessage(t("additionalRewards.raidGiftSaved"));
    } catch {
      setMessage(t("additionalRewards.raidStatusFailed"));
    } finally {
      setUpdatingRaidGift(false);
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

        const derivedStatus = deriveEventSubStatus(subs, rewardIdToCheck);
        logger.info("[EventSub] Status check", { ...derivedStatus, rewardIdToCheck, subsLength: subs.length });
        setEventSubStatus(derivedStatus.rewardStatus);
        setRaidEventSubStatus(derivedStatus.raidStatus);
        setRaidEventSubWarning("");
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
      fetchRaidGachaStatus();
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
      // Validate: Cannot use a reward that is already an additional reward
      // バリデーション: 追加報酬として既に登録されているものはメイン報酬に設定できない
      const isAlreadyAdditional = additionalRewards.some(
        (ar) => ar.reward_id === selectedRewardId
      );
      if (isAlreadyAdditional) {
        setMessage(t("additionalRewards.cannotUseAsMain"));
        setSaving(false);
        return;
      }

      // Check if main reward is being changed - need to delete old subscription first
      // メイン報酬が変更される場合、古いサブスクリプションを先に削除する必要がある
      if (savedMainRewardId && savedMainRewardId !== selectedRewardId) {
        const existingOldSub = subscriptions.find(
          (sub) => sub.condition.reward_id === savedMainRewardId
        );
        if (existingOldSub) {
          logger.info(`Main reward changing from ${savedMainRewardId} to ${selectedRewardId}, deleting old subscription`);
          await fetch(`/api/twitch/eventsub/subscribe?rewardId=${savedMainRewardId}`, {
            method: "DELETE",
            credentials: "include",
          });
        }
      }

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
      const raidSubscriptionWarning = getRaidSubscriptionWarning(eventSubData);
      const raidSubscriptionStatus = getRaidSubscriptionStatus(eventSubData);

      // レスポンスのsuccessフィールドで判定（ステータスコードではなく）
      if (eventSubData.success) {
        setMessage(raidSubscriptionWarning || eventSubData.message || t("messages.saveSuccess"));
        setEventSubStatus("pending");
        setRegistrationFailed(false);
        setSavedMainRewardId(selectedRewardId);
        // Refresh status - 保存した報酬IDを明示的に渡して正しく比較
        await fetchEventSubStatus(selectedRewardId);
        setRaidEventSubWarning(raidSubscriptionWarning);
        if (raidSubscriptionStatus) {
          setRaidEventSubStatus(raidSubscriptionWarning ? "error" : raidSubscriptionStatus);
        } else if (raidSubscriptionWarning) {
          setRaidEventSubStatus("error");
        }
      } else if (eventSubData.warning) {
        // 警告状態：サブスクリプションの確認が必要
        setMessage(eventSubData.message || "状態を確認してください");
        setEventSubStatus("pending");
        setRegistrationFailed(false);
        setSavedMainRewardId(selectedRewardId);
        await fetchEventSubStatus(selectedRewardId);
        setRaidEventSubWarning(raidSubscriptionWarning);
        if (raidSubscriptionStatus) {
          setRaidEventSubStatus(raidSubscriptionWarning ? "error" : raidSubscriptionStatus);
        } else if (raidSubscriptionWarning) {
          setRaidEventSubStatus("error");
        }
      } else if (eventSubResponse.status === 429) {
        setMessage(eventSubData.error || t("messages.rateLimit"));
      } else {
        // Registration failed - webhook unreachable or other error
        // 登録失敗 - Webhookに到達できないか、その他のエラー
        logger.error("EventSub error:", eventSubData);
        setMessage(eventSubData.error || t("messages.eventsubFailed"));
        setEventSubStatus("error");
        setRegistrationFailed(true);
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
        }),
      });

      const eventSubData = await eventSubResponse.json();
      const raidSubscriptionWarning = getRaidSubscriptionWarning(eventSubData);
      const raidSubscriptionStatus = getRaidSubscriptionStatus(eventSubData);

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
          drawCount: additionalDrawCount,
          isRaidLimited: false,
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
      setMessage(raidSubscriptionWarning || t("additionalRewards.addSuccess"));
      setSelectedAdditionalRewardId("");
      setAdditionalDrawCount(1);
      await fetchAdditionalRewards();
      await fetchEventSubStatus(selectedRewardId);
      setRaidEventSubWarning(raidSubscriptionWarning);
      if (raidSubscriptionStatus) {
        setRaidEventSubStatus(raidSubscriptionWarning ? "error" : raidSubscriptionStatus);
      } else if (raidSubscriptionWarning) {
        setRaidEventSubStatus("error");
      }

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
      setSavedMainRewardId("");
      setEventSubStatus("none");
      setRaidEventSubStatus("none");
      setRaidEventSubWarning("");
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

  /**
   * チャネルポイント用スコープをstep-up再認証で取得する。
   * チャネルポイント連携は初回ログインでは要求されないため、
   * 配信者が連携を有効化する瞬間にこのフローで必要スコープを付与する。
   *
   * Trigger step-up OAuth to grant Channel Points scopes.
   * Initial login does not request Channel Points scopes (least-privilege);
   * streamers grant them here when they enable the Channel Points integration.
   */
  const handleReauthorize = useCallback(async () => {
    setReauthorizing(true);
    setError("");
    setMessage("");

    try {
      const response = await fetch("/api/auth/reauth", {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          additionalScopes: CHANNEL_POINT_SCOPES,
        }),
      });

      if (response.ok) {
        const data = await response.json();
        // state をCookieに保存してからリダイレクト（callbackでの検証用）
        // Persist state to cookie before redirect (callback verifies state)
        if (data.state) {
          document.cookie = `twitch_auth_state=${data.state}; path=/; max-age=600; secure; samesite=lax`;
        }
        window.location.href = data.loginUrl;
        return;
      }

      const errorData = await response.json().catch(() => ({}));
      setError(errorData.error || t("messages.reauthorizeFailed"));
    } catch (err) {
      logger.error("Failed to reauthorize for channel points:", err);
      setError(t("messages.reauthorizeFailed"));
    } finally {
      setReauthorizing(false);
    }
  }, [t]);

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

  const getStatusText = (status: EventSubStatus) => t(`status.${status}`);
  const getStatusColor = (status: EventSubStatus) => {
    switch (status) {
      case "active":
        return "text-green-400";
      case "error":
        return "text-red-400";
      case "pending":
        return "text-yellow-400";
      default:
        return "text-gray-400";
    }
  };

  const getSubscriptionLabel = (sub: EventSubSubscription) => {
    if (sub.type === RAID_EVENTSUB_TYPE) {
      return t("form.raidEventSubStatus");
    }

    if (!sub.condition.reward_id) {
      return t("form.allRewards");
    }

    return (
      <>
        {getRewardNameById(sub.condition.reward_id) || `${t("form.rewardId")} ${sub.condition.reward_id.slice(0, 8)}...`}
        <span className="ml-1 text-gray-500">
          ({sub.condition.reward_id.slice(0, 8)}...)
        </span>
      </>
    );
  };

  return (
    <div className="rounded-xl bg-gray-800 p-6">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-xl font-semibold text-white">
          {t("title")}
        </h2>
        {getEventSubStatusBadge()}
      </div>

       {needsReauth ? (
         // スコープ不足時のstep-up再認証導線。
         // 初回ログインではチャネルポイント系スコープを要求しないため、
         // 配信者が連携を有効化するこの画面で明示的に同意を求める。
         // Step-up reauth CTA when channel point scopes are missing.
         // Initial login omits these scopes (least-privilege); ask the streamer
         // to grant them on this settings screen when enabling the integration.
         <div className="rounded-lg border border-yellow-500/30 bg-yellow-500/10 p-4">
           <p className="mb-3 text-sm text-yellow-300">
             {t("messages.scopeRequired")}
           </p>
           <button
             onClick={handleReauthorize}
             disabled={reauthorizing}
             className="rounded-lg bg-purple-600 px-4 py-2 text-sm text-white hover:bg-purple-700 disabled:opacity-50"
           >
             {reauthorizing ? t("buttons.reauthorizing") : t("buttons.reauthorize")}
           </button>
           {error && (
             <p className="mt-3 text-sm text-red-400">
               {error}
             </p>
           )}
         </div>
       ) : error ? (
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
               {rewards
                 .filter((reward) =>
                   // Exclude rewards that are already registered as additional rewards
                   // 追加報酬として既に登録されているものを除外
                   !additionalRewards.some((ar) => ar.reward_id === reward.id)
                 )
                 .map((reward) => (
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
             <div className="mb-3 rounded bg-gray-800/60 p-3 text-xs">
               <div className="flex items-center justify-between gap-3">
                 <span className="text-gray-300">{t("form.raidEventSubStatus")}</span>
                 <span className={getStatusColor(raidEventSubStatus)}>
                   {getStatusText(raidEventSubStatus)}
                 </span>
               </div>
               <p className="mt-1 text-gray-500">
                 {raidEventSubStatus === "active"
                   ? t("form.raidEventSubActive")
                   : raidEventSubStatus === "error"
                     ? t("form.raidEventSubError")
                     : t("form.raidEventSubMissing")}
               </p>
               {raidEventSubWarning && (
                 <p className="mt-2 text-red-300">
                   {raidEventSubWarning}
                 </p>
               )}
             </div>
             {subscriptions.length > 0 ? (
               <div className="space-y-2">
                 {subscriptions.map((sub) => (
                   <div key={sub.id}>
                     <div className="flex items-center justify-between text-xs">
                       <span className="text-gray-400">
                         {getSubscriptionLabel(sub)}
                       </span>
                       <span className={
                         sub.status === "enabled"
                           ? "text-green-400"
                           : ["webhook_callback_verification_failed", "notification_failures_exceeded", "authorization_revoked"].includes(sub.status)
                             ? "text-red-400"
                             : "text-yellow-400"
                       }>
                         {/* Display user-friendly status text */}
                         {/* ユーザーフレンドリーなステータステキストを表示 */}
                         {sub.status === "enabled"
                           ? "有効"
                           : sub.status === "webhook_callback_verification_pending"
                             ? "接続確認中"
                             : ["webhook_callback_verification_failed", "notification_failures_exceeded", "authorization_revoked"].includes(sub.status)
                               ? "失敗：時間をおいて再設定してください"
                               : sub.status}
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
             ) : registrationFailed ? (
               /* Registration failed - webhook unreachable */
               /* 登録失敗 - Webhookに到達できなかった */
               <div className="rounded bg-red-500/10 p-3 text-xs text-red-300">
                 <p className="font-medium">接続失敗</p>
                 <p className="mt-1 text-red-400/80">
                   EventSubの登録に失敗しました。Webhookエンドポイントに到達できませんでした。
                 </p>
                 <ul className="mt-1 list-inside list-disc text-red-400/70">
                   <li>サーバーが外部からアクセス可能か確認してください</li>
                   <li>時間をおいて「保存 & EventSub登録」ボタンで再登録してください</li>
                 </ul>
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
                       {/* テキストが長い場合にコンテナからはみ出さないようにする */}
                       <div className="min-w-0 flex-1 overflow-hidden">
                         <span className="text-sm text-gray-200 break-all">
                           {reward.reward_name || reward.reward_id.slice(0, 8) + "..."}
                         </span>
                         <span className="ml-2 text-xs text-gray-400 whitespace-nowrap">
                           ({reward.reward_id.slice(0, 8)}...)
                         </span>
                         <div className="mt-1 flex flex-wrap gap-1 text-xs">
                           {reward.draw_count > 1 && (
                             <span className="rounded bg-purple-500/20 px-2 py-0.5 text-purple-200">
                               {t("additionalRewards.multiDraw", { count: reward.draw_count })}
                             </span>
                           )}
                           {reward.is_raid_limited && (
                             <span className="rounded bg-cyan-500/20 px-2 py-0.5 text-cyan-200">
                               {t("additionalRewards.raidLimited")}
                             </span>
                           )}
                         </div>
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

               <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded bg-gray-600/50 px-3 py-2">
                 <div>
                   <div className="text-sm text-gray-200">
                     {t("additionalRewards.raidGiftTitle")}
                   </div>
                   <div className="text-xs text-gray-400">
                     {raidGiftDrawCount > 0
                       ? t("additionalRewards.raidGiftEnabled", { count: raidGiftDrawCount })
                       : t("additionalRewards.raidGiftDisabled")}
                   </div>
                 </div>
                 <div className="flex items-center gap-2">
                   <input
                     type="number"
                     min={0}
                     max={10}
                     value={raidGiftDrawCount}
                     onChange={(e) => setRaidGiftDrawCount(Math.min(10, Math.max(0, Number(e.target.value) || 0)))}
                     className="w-16 rounded bg-gray-700 px-2 py-1 text-sm text-gray-100"
                   />
                   <button
                     type="button"
                     onClick={updateRaidGiftSettings}
                     disabled={updatingRaidGift}
                     className="rounded-lg bg-cyan-600 px-3 py-2 text-xs text-white hover:bg-cyan-700 disabled:opacity-50"
                   >
                     {updatingRaidGift ? tCommon("loading") : tCommon("save")}
                   </button>
                 </div>
               </div>

               {/* Add new additional reward */}
               {/* 新しい追加報酬を追加 */}
               <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_110px_auto] sm:items-center">
                 <select
                   value={selectedAdditionalRewardId}
                   onChange={(e) => setSelectedAdditionalRewardId(e.target.value)}
                   className="min-w-0 rounded-lg bg-gray-600 px-3 py-2 text-sm text-gray-200"
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
                 <label className="flex items-center gap-2 rounded-lg bg-gray-600 px-3 py-2 text-sm text-gray-200">
                   <span className="whitespace-nowrap text-xs text-gray-300">
                     {t("additionalRewards.drawCount")}
                   </span>
                   <input
                     type="number"
                     min={1}
                     max={10}
                     value={additionalDrawCount}
                     onChange={(e) => setAdditionalDrawCount(Math.min(10, Math.max(1, Number(e.target.value) || 1)))}
                     className="w-12 rounded bg-gray-700 px-2 py-1 text-sm text-gray-100"
                   />
                 </label>
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
               onClick={() => { fetchRewards(); fetchEventSubStatus(); fetchAdditionalRewards(); setRegistrationFailed(false); }}
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
