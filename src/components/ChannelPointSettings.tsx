"use client";

import { useState, useEffect, useCallback, useId } from "react";
import { useTranslations } from "next-intl";
import { logger } from "@/lib/logger";
import { CHANNEL_POINT_SCOPES } from "@/lib/twitch/scopes";
import { parseTwitchAuthorizationResponse } from "@/lib/twitch/authorization-response";
import { DEFAULT_PACK_SENTINEL, isReservedCollectionName } from "@/lib/validation/collection-name";
import {
  deriveEventSubStatus,
  RAID_EVENTSUB_TYPE,
  type EventSubStatus,
  type EventSubSubscriptionForStatus,
} from "@/lib/twitch/eventsub-status";
import { parseMaintenanceError } from "@/lib/maintenance/client";
import { useMaintenanceStatus } from "./MaintenanceStatusProvider";

export { deriveEventSubStatus } from "@/lib/twitch/eventsub-status";

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
  // Issue #393: card pack bound to this additional reward (null = all cards)
  collection_name: string | null;
  created_at: string;
}

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

interface ChannelPointSettingsProps {
  streamerId: string;
  currentRewardId: string | null;
  currentRewardName: string | null;
  // Issue #393: pack currently bound to the main reward (null = all cards)
  currentCollectionName?: string | null;
  /**
   * compact: シンプル表示モード用の縮約レンダリング。
   * EventSub 診断パネル / 追加報酬セクション / 詳細エラーリストを隠し、
   * 報酬選択 + ステータスピル + 保存ボタンの最小構成にする。
   * Hide diagnostic panel, additional rewards, and verbose error states
   * to give beginners a focused, low-noise reward picker.
   */
  compact?: boolean;
  /**
   * Issue #554: カードパックのプルダウン表示制御 + デフォルト名。
   * `undefined`(未指定)の場合は従来どおりの表示(常に有効なselect、
   * デフォルト名は汎用ラベル)にフォールバックする — 既存の呼び出し元
   * (テスト含む)を壊さないための後方互換。
   */
  cardPacks?: {
    // false: 新規のパック紐付け(選択)は支援プラン/Twitchサブスク限定。
    // 既存の紐付けは維持される(ダウングレード耐性 — 黙って解除しない)。
    canManage: boolean;
    // 「デフォルト」(未分類)パックの表示名オーバーライド。null は汎用ラベル。
    defaultPackName: string | null;
  };
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
  currentCollectionName = null,
  compact = false,
  cardPacks,
}: ChannelPointSettingsProps) {
  const t = useTranslations("channelPointSettings");
  const tCommon = useTranslations("common");
  const tMaintenance = useTranslations("maintenance");
  // #694 Stage 6c: ダッシュボード共有Context経由のmaintenance状態。
  // 各書き込みボタンのたびに個別fetchしない設計（MaintenanceStatusProvider参照）。
  const { mode: maintenanceMode } = useMaintenanceStatus();
  const isMaintenanceBlocked = maintenanceMode !== "off";
  const [rewards, setRewards] = useState<TwitchReward[]>([]);
  const [selectedRewardId, setSelectedRewardId] = useState(currentRewardId || "");
  const [selectedRewardName, setSelectedRewardName] = useState(currentRewardName || "");
  // Issue #393: pack selections + available pack list
  const [selectedCollectionName, setSelectedCollectionName] = useState(currentCollectionName || "");
  const [collections, setCollections] = useState<string[]>([]);
  // collectionsLoaded: true のときだけ「登録解除済み」警告を出す。
  // 取得前/取得失敗時に実在パックを誤警告しないためのガード。
  const [collectionsLoaded, setCollectionsLoaded] = useState(false);
  const [selectedAdditionalCollectionName, setSelectedAdditionalCollectionName] = useState("");
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
  const [subscriptions, setSubscriptions] = useState<EventSubSubscriptionForStatus[]>([]);
  // Issue #1019: 再認証（step-up）失敗の表示は bootstrap 系の汎用 error と分離する。
  // 従来 error を流用すると、外側の `error ? <赤箱>` が真になり authorization_revoked バナーごと
  // 置き換わるデッドコードや、再認証と無関係な bootstrap 失敗文言がボタン直下に誤帰属する問題が出る。
  // そのため再認証専用の state を持ち、外側の赤箱は従来どおり error のみに反応させる。
  const [reauthError, setReauthError] = useState("");
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
  const fetchChannelPointBootstrap = useCallback(async (includeDiagnostics: boolean) => {
    try {
      const response = await fetch(
        `/api/twitch/channel-point-bootstrap?diagnostics=${includeDiagnostics ? "1" : "0"}`,
        { credentials: "include" },
      );
      if (!response.ok) {
        // Issue #1018: トークン恒久失効時はバックエンドが401で
        // { error, requiresReauth: true } を返す。再認証導線(step-up CTA)は
        // body側にあるため、!response.okでもbodyを読みrequiresReauthを
        // 判定する。JSONでなければ従来どおり汎用エラー表示にフォールバック。
        const errorData = await response.json().catch(() => null);
        if (errorData && errorData.requiresReauth === true) {
          // 直前にセットするはずの「取得に失敗しました」文言は再認証導線と
          // 矛盾するためクリアし、needsReauthバナー(scopeRequired+CTA)のみ
          // を表示する。
          setError("");
          setNeedsReauth(true);
          return;
        }
        setError(t("messages.fetchFailed"));
        return;
      }
      const data = await response.json();
      if (!data.hasRequiredScope || data.requiresReauth) {
        setNeedsReauth(true);
        return;
      }

      setNeedsReauth(false);
      // #788: 旧affiliateRequired文字列契約をCapability状態ベースの契約へ置き換える。
      // 403(Twitch側の利用不可)はcapability==="unavailable"、429/5xx等の一時失敗は
      // temporarilyUnavailableで区別し、それぞれ別の文言・再試行導線を表示する。
      if (data.capability === "unavailable") {
        setError(t("messages.channelPointsUnavailable"));
      } else if (data.temporarilyUnavailable) {
        setError(t("messages.temporarilyUnavailable"));
      }
      setRewards(Array.isArray(data.rewards) ? data.rewards : []);

      if (includeDiagnostics) {
        setSubscriptions(Array.isArray(data.subscriptions) ? data.subscriptions : []);
        if (data.eventSubStatus) setEventSubStatus(data.eventSubStatus);
        if (data.raidEventSubStatus) setRaidEventSubStatus(data.raidEventSubStatus);
        if (Array.isArray(data.additionalRewards)) {
          setAdditionalRewards(data.additionalRewards);
          logger.info("[AdditionalRewards] Bootstrapped additional rewards", { count: data.additionalRewards.length });
        }
        if (typeof data.raidGiftDrawCount !== "undefined") {
          // Issue #641: upper bound raised from 10 to 15 (fixed limit, confirmed by owner).
          setRaidGiftDrawCount(Math.min(15, Math.max(0, Number(data.raidGiftDrawCount ?? 0))));
        }
      }
    } catch (err) {
      logger.error("Failed to bootstrap channel point settings:", err);
      setError(t("messages.fetchFailed"));
    }
  }, [t]);

  const fetchRewards = async () => {
    setLoading(true);
    setError("");

    try {
      await fetchChannelPointBootstrap(!compact);
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

  // Issue #393: load the streamer's pack names for the collection dropdowns.
  // Uses the dedicated lightweight endpoint (DISTINCT, active-only) instead of
  // fetching the full card list and reshaping it client-side.
  const fetchCollections = useCallback(async () => {
    if (!streamerId) return;
    try {
      const response = await fetch(
        `/api/cards/collections?streamerId=${encodeURIComponent(streamerId)}`,
        { credentials: "include", cache: "no-store" }
      );
      if (!response.ok) return;
      const data = await response.json();
      const names = Array.isArray(data?.collections) ? data.collections : [];
      // Issue #555: 予約語(`__` 始まり)は防御的に除外する。予約語ガード
      // (isReservedCollectionName)導入前に "__default__" 等の実パックが
      // 登録されていた遺産データが残っている場合、固定オプション
      // (DEFAULT_PACK_SENTINEL)と同じ value の option が重複描画され、
      // その実パックを選択できなくなる value 衝突を防ぐ。
      setCollections(
        names.filter(
          (name: unknown): name is string =>
            typeof name === "string" && !isReservedCollectionName(name)
        )
      );
      // 取得成功時のみ loaded=true。これ以降だけ missing 警告を有効化する。
      setCollectionsLoaded(true);
    } catch {
      logger.error("Failed to fetch card collections");
    }
  }, [streamerId]);

  const fetchRaidGachaStatus = useCallback(async () => {
    try {
      const response = await fetch("/api/streamer/raid-gacha", {
        credentials: "include",
        cache: "no-store",
      });
      if (response.ok) {
        const data = await response.json();
        // Issue #641: upper bound raised from 10 to 15 (fixed limit, confirmed by owner).
        setRaidGiftDrawCount(Math.min(15, Math.max(0, Number(data.drawCount ?? 0))));
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
        const maintenanceError = parseMaintenanceError(response, data);
        setMessage(maintenanceError?.message || data.error || t("additionalRewards.raidStatusFailed"));
        return;
      }

      // Issue #641: upper bound raised from 10 to 15 (fixed limit, confirmed by owner).
      setRaidGiftDrawCount(Math.min(15, Math.max(0, Number(data.drawCount ?? 0))));
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
        logger.info("[EventSub] API response", { subsCount: subs.length, subs: subs.map((s: EventSubSubscriptionForStatus) => ({ id: s.id, status: s.status, reward_id: s.condition.reward_id })) });
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
    // compact modeでは初期表示の外部診断APIを避け、詳細表示時のみbootstrapでまとめて取得する。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Issue #393: パック名一覧をメイン/追加報酬のドロップダウン用に取得。
  // streamerId 変更時に取り直す（/api/cards/collections は軽量なため compact でも取得）。
  useEffect(() => {
    fetchCollections();
  }, [fetchCollections]);

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
        // #694 Stage 6c: maintenance mode による503拒否ならサーバーの案内文言を
        // 優先する（事前disableをすり抜けた場合のフォールバック表示）。
        const errorData = await response.json().catch(() => ({}));
        const maintenanceError = parseMaintenanceError(response, errorData);
        setMessage(maintenanceError?.message || t("messages.createRewardFailed"));
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
          // Issue #393: bind the main reward to a pack ("" → null = all cards)
          channelPointCollectionName: selectedCollectionName || null,
        }),
      });

      if (settingsResponse.status === 429) {
        const errorData = await settingsResponse.json();
        setMessage(errorData.error || t("messages.rateLimit"));
        return;
      }

      if (!settingsResponse.ok) {
        // Surface the server's specific error (e.g. Issue #393 empty-pack rejection).
        // maintenance mode による503拒否ならサーバーの案内文言を優先する。
        const errorData = await settingsResponse.json().catch(() => null);
        const maintenanceError = parseMaintenanceError(settingsResponse, errorData);
        setMessage(maintenanceError?.message || errorData?.error || t("messages.saveFailed"));
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
        setMessage(eventSubData.message || t("messages.checkStatus"));
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
        // #694 Stage 6c: maintenance mode による503拒否時、body は
        // `{error: {code, message, ...}}` 形状(eventSubData.errorはオブジェクト)
        // のため、そのままsetMessageすると"[object Object]"表示になる
        // （CardManagerの既知バグと同種）。parseMaintenanceErrorで先に判定する。
        logger.error("EventSub error:", eventSubData);
        const maintenanceError = parseMaintenanceError(eventSubResponse, eventSubData);
        setMessage(maintenanceError?.message || (typeof eventSubData.error === "string" ? eventSubData.error : t("messages.eventsubFailed")));
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
        // #694 Stage 6c: maintenance mode による503拒否時はeventSubData.errorが
        // オブジェクト形状のため、先にparseMaintenanceErrorで判定する
        // （"[object Object]"表示の防止、ChannelPointSettings.handleSaveと同じ方針）。
        const maintenanceError = parseMaintenanceError(eventSubResponse, eventSubData);
        setMessage(maintenanceError?.message || (typeof eventSubData.error === "string" ? eventSubData.error : t("additionalRewards.addFailed")));
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
          // Issue #393: bind this additional reward to a pack ("" → null = all cards)
          collectionName: selectedAdditionalCollectionName || null,
        }),
      });

      const dbData = await dbResponse.json();

      if (!dbResponse.ok) {
        const maintenanceError = parseMaintenanceError(dbResponse, dbData);
        setMessage(maintenanceError?.message || dbData.error || t("additionalRewards.addFailed"));
        setAddingAdditional(false);
        return;
      }

      // 3. Update state
      // 状態を更新
      setMessage(raidSubscriptionWarning || t("additionalRewards.addSuccess"));
      setSelectedAdditionalRewardId("");
      setSelectedAdditionalCollectionName("");
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
        const maintenanceError = parseMaintenanceError(dbResponse, dbData);
        setMessage(maintenanceError?.message || dbData.error || t("additionalRewards.removeFailed"));
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
        const maintenanceError = parseMaintenanceError(settingsResponse, errorData);
        setMessage(maintenanceError?.message || errorData.error || t("messages2.disconnectFailed"));
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
    setReauthError("");
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
        // 壊れたAPI応答や侵害時の外部URLをそのままwindow.locationへ渡さないため、
        // ChatAnnouncementSettingsのreauth/BOT接続と同じorigin/path/state検証を通す
        // （Issue #865フォローアップ）。
        const authorization = parseTwitchAuthorizationResponse(data);
        if (!authorization) {
          setReauthError(t("messages.reauthorizeFailed"));
          return;
        }
        // state をCookieに保存してからリダイレクト（callbackでの検証用）
        // Persist state to cookie before redirect (callback verifies state)
        document.cookie = `twitch_auth_state=${authorization.state}; path=/; max-age=600; secure; samesite=lax`;
        window.location.href = authorization.loginUrl;
        return;
      }

      const errorData = await response.json().catch(() => ({}));
      const maintenanceError = parseMaintenanceError(response, errorData);
      setReauthError(maintenanceError?.message || errorData.error || t("messages.reauthorizeFailed"));
    } catch (err) {
      logger.error("Failed to reauthorize for channel points:", err);
      setReauthError(t("messages.reauthorizeFailed"));
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

  const getSubscriptionLabel = (sub: EventSubSubscriptionForStatus) => {
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

  // Issue #554: 「デフォルト」パックの表示名。cardPacks 未指定/未設定時は
  // 汎用ラベル("デフォルトパック")にフォールバックする。
  const defaultPackDisplayName = cardPacks?.defaultPackName ?? t("collections.defaultOnlyName");

  // Issue #554: パックselectの表示モード。
  // - "enabled" : 通常どおり選択可能(cardPacks未指定 = 後方互換、または
  //   canManage=trueのとき常にこのモード)。
  // - "disabled": canManage=false だが既存の紐付けがある(ダウングレード後、
  //   黙って解除しないための維持表示)。
  // - "hidden"  : canManage=false かつ紐付けなし(邪魔にならないアップセル表示に置き換える)。
  //
  // 注意: この表示制御は progressive disclosure / アップセル導線としての
  // 「UX」であり、セキュリティ境界ではない。サーバー側 (/api/streamer/settings)
  // は意図的に既存パックの紐付け(選択)をプランでゲートしない — #553 の確立済み
  // 設計 (src/lib/plan-gate.ts:「Assigning an EXISTING pre-defined pack ... is
  // never gated」) のとおり、ゲート対象は「新規パック名の登録」のみ。basic
  // ユーザーがAPIを直接叩いて紐付けても、そもそもパックを登録できない以上
  // 実質的な価値流出はない(sentinel "__default__" の直接指定も、パックを
  // 持たないユーザーには「全カード」と等価で無害)。
  //
  // NOTE: this display control is a progressive-disclosure / upsell UX, NOT a
  // security boundary. The server deliberately does not plan-gate assigning an
  // existing pack (see src/lib/plan-gate.ts) — only registering NEW pack names
  // is gated, so bypassing this UI yields nothing of value to a basic user.
  const resolvePackControlMode = (hasBinding: boolean): "enabled" | "disabled" | "hidden" => {
    if (!cardPacks || cardPacks.canManage) return "enabled";
    return hasBinding ? "disabled" : "hidden";
  };
  const mainPackControlMode = resolvePackControlMode(selectedCollectionName !== "");
  const additionalPackControlMode = resolvePackControlMode(selectedAdditionalCollectionName !== "");
  // canManage=true だが登録済みパックが0件の場合の案内(「すべてのカード」
  // 「デフォルトパックのみ」は常に有効な選択肢のため、select自体は表示する)。
  const showNoPacksRegisteredHint = Boolean(cardPacks?.canManage) && collections.length === 0;

  // Issue #554: パック機能が支援プラン/Twitchサブスク限定である旨の
  // アップセル表示。邪魔にならないよう text-xs のグレーアウトテキストとする。
  // リンク文言「支援特典について」は他コンポーネント(CardPackModal 等)と
  // 同じ既存パターンを踏襲し、あえて i18n キー化せずハードコードしている。
  const renderPackUpsellHint = () => (
    <p className="mt-1 text-xs text-gray-500">
      {t("collections.premiumLocked")}
      <a href="/plans" className="ml-1 text-purple-400 hover:text-purple-300 underline">
        {tCommon("supportPlanInfo")}
      </a>
    </p>
  );

  return (
    <div className="rounded-xl bg-gray-800 p-6">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-xl font-semibold text-white">
          {t("title")}
        </h2>
        {getEventSubStatusBadge()}
      </div>

      {isMaintenanceBlocked && (
        <p className="mb-4 text-sm text-yellow-400">{tMaintenance("writeDisabled")}</p>
      )}

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
              disabled={reauthorizing || isMaintenanceBlocked}
              title={isMaintenanceBlocked ? tMaintenance("writeDisabled") : undefined}
              className="rounded-lg bg-purple-600 px-4 py-2 text-sm text-white hover:bg-purple-700 disabled:opacity-50"
            >
              {reauthorizing ? t("buttons.reauthorizing") : t("buttons.reauthorize")}
            </button>
            {reauthError && (
              <p className="mt-3 text-sm text-red-400" role="alert">
                {reauthError}
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
         <div className={compact ? "space-y-4" : "space-y-6"}>
           {/* Issue #556: 接続状況セクション。EventSub(Twitch通知)の登録状態と
               診断情報を1つのセクションに集約する。見出し・説明は SectionCard
               側で描画するため、旧マークアップにあった内部 h3(EventSub ステータス)
               は削除した(二重見出しの防止)。compact mode では診断ノイズを隠す。 */}
           {!compact && (
           <SectionCard
             title={t("sections.connection")}
             description={t("sections.connectionDesc")}
           >
             {/* Issue #556: SectionCard の bg-gray-900/30 上では旧 bg-gray-800/60
                 だけだと輝度差が小さく境界が曖昧になるため、細い枠線で
                 診断ボックスの範囲を明示する(チームレビュー指摘への対応)。 */}
             <div className="mb-3 rounded-md border border-gray-700/60 bg-gray-800/60 p-3 text-xs">
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
                            ? t("eventSubStatus.enabled")
                            : sub.status === "webhook_callback_verification_pending"
                              ? t("eventSubStatus.pending")
                              : ["webhook_callback_verification_failed", "notification_failures_exceeded", "authorization_revoked"].includes(sub.status)
                                ? t("eventSubStatus.failed")
                                : sub.status}
                        </span>
                      </div>
                      {/* Explanation for pending verification status */}
                      {/* 検証待ち状態の説明 */}
                      {sub.status === "webhook_callback_verification_pending" && (
                        <div className="mt-1 rounded bg-yellow-500/10 p-2 text-xs text-yellow-300">
                          <p className="font-medium">{t("eventSubStatus.pendingTitle")}</p>
                          <p className="mt-1 text-yellow-400/80">
                            {t("eventSubStatus.pendingDescription")}
                          </p>
                          <ul className="mt-1 list-inside list-disc text-yellow-400/70">
                            <li>{t("eventSubStatus.pendingItem1")}</li>
                            <li>{t("eventSubStatus.pendingItem2")}</li>
                            <li>{t("eventSubStatus.pendingItem3")}</li>
                          </ul>
                        </div>
                      )}
                      {/* Explanation for failed verification status */}
                      {/* 検証失敗状態の説明 */}
                      {sub.status === "webhook_callback_verification_failed" && (
                        <div className="mt-1 rounded bg-red-500/10 p-2 text-xs text-red-300">
                          <p className="font-medium">{t("eventSubStatus.verificationFailedTitle")}</p>
                          <p className="mt-1 text-red-400/80">
                            {t("eventSubStatus.verificationFailedDescription")}
                          </p>
                          <ul className="mt-1 list-inside list-disc text-red-400/70">
                            <li>{t("eventSubStatus.verificationFailedItem1")}</li>
                            <li>{t("eventSubStatus.verificationFailedItem2")}</li>
                          </ul>
                        </div>
                      )}
                      {/* Explanation for notification failures exceeded */}
                      {/* 通知失敗超過の説明 */}
                      {sub.status === "notification_failures_exceeded" && (
                        <div className="mt-1 rounded bg-red-500/10 p-2 text-xs text-red-300">
                          <p className="font-medium">{t("eventSubStatus.notificationFailuresTitle")}</p>
                          <p className="mt-1 text-red-400/80">
                            {t("eventSubStatus.notificationFailuresDescription")}
                          </p>
                          <ul className="mt-1 list-inside list-disc text-red-400/70">
                            <li>{t("eventSubStatus.notificationFailuresItem1")}</li>
                            <li>{t("eventSubStatus.notificationFailuresItem2")}</li>
                          </ul>
                        </div>
                      )}
                      {/* Explanation for authorization revoked */}
                      {/* 認証取り消しの説明 */}
                      {sub.status === "authorization_revoked" && (
                        <div className="mt-1 rounded bg-red-500/10 p-2 text-xs text-red-300">
                          <p className="font-medium">{t("eventSubStatus.authorizationRevokedTitle")}</p>
                          <p className="mt-1 text-red-400/80">
                            {t("eventSubStatus.authorizationRevokedDescription")}
                          </p>
                          <ul className="mt-1 list-inside list-disc text-red-400/70">
                            <li>{t("eventSubStatus.authorizationRevokedItem1")}</li>
                            <li>{t("eventSubStatus.authorizationRevokedItem2")}</li>
                          </ul>
                          {/* Issue #1019: authorization_revoked バナー内に再認証ボタンを配置。
                              従来はこのバナーにボタンが無く、再連携ボタン(needsReauth分岐)は
                              接続状況セクション全体を置き換えるため同時に見えなかった。
                              ボタン押下で step-up 再認証(handleReauthorize)を起動し、
                              権限復旧後は「保存 & EventSub登録」が必要(再認証callbackは
                              EventSubを再登録しないため item2 の文言と整合)。 */}
                          <button
                            onClick={handleReauthorize}
                            disabled={reauthorizing || isMaintenanceBlocked}
                            title={isMaintenanceBlocked ? tMaintenance("writeDisabled") : undefined}
                            className="mt-3 rounded-lg bg-purple-600 px-4 py-2 text-xs font-medium text-white hover:bg-purple-700 disabled:opacity-50"
                          >
                            {reauthorizing ? t("buttons.reauthorizing") : t("buttons.reauthorize")}
                          </button>
                          {reauthError && (
                            <p className="mt-2 text-xs text-red-400" role="alert">
                              {reauthError}
                            </p>
                          )}
                        </div>
                      )}
                      {/* Callback URL mismatch warning */}
                      {/* Callback URL不一致の警告 */}
                      {sub.debug && !sub.debug.callbackMatch && (
                        <div className="mt-1 rounded bg-red-500/10 p-2 text-xs text-red-300">
                          <p className="font-medium">{t("eventSubStatus.callbackMismatchTitle")}</p>
                          <p className="mt-1 text-red-400/80">
                            {t("eventSubStatus.callbackMismatchDescription")}
                          </p>
                          <p className="mt-1 text-red-400/60 break-all">
                            {t("eventSubStatus.callbackMismatchCurrent", {
                              callback: sub.transport?.callback || t("eventSubStatus.unknown"),
                            })}
                          </p>
                          <p className="text-red-400/60 break-all">
                            {t("eventSubStatus.callbackMismatchExpected", { url: sub.debug.expectedCallbackUrl })}
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
                  <p className="font-medium">{t("eventSubStatus.registrationFailedTitle")}</p>
                  <p className="mt-1 text-red-400/80">
                    {t("eventSubStatus.registrationFailedDescription")}
                  </p>
                  <ul className="mt-1 list-inside list-disc text-red-400/70">
                    <li>{t("eventSubStatus.registrationFailedItem1")}</li>
                    <li>{t("eventSubStatus.registrationFailedItem2")}</li>
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
           </SectionCard>
           )}

           {/* Issue #556: メイン報酬セクション。報酬の選択・作成と、引き換え対象
               カードパックの紐付けを1つのセクションにまとめる。compact(シンプル
               モード)では SectionCard がフラグメントとして children をそのまま
               返すため、DOM 構造・クラスは再構成前と完全に一致する
               (シンプルモードの見た目は変えない制約)。 */}
           <SectionCard
             compact={compact}
             title={t("sections.mainReward")}
             description={t("sections.mainRewardDesc")}
           >
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
                   disabled={creating || isMaintenanceBlocked}
                   title={isMaintenanceBlocked ? tMaintenance("writeDisabled") : undefined}
                   className="rounded-lg bg-purple-600 px-4 py-2 text-sm text-white hover:bg-purple-700 disabled:opacity-50"
                 >
                   {creating ? t("buttons.creating") : t("buttons.createReward")}
                 </button>
               </div>
             )}

             {selectedRewardId && !compact && (
               <div className="rounded-lg bg-gray-700 p-3">
                 <p className="text-sm text-gray-400">
                   {t("form.selected")} <span className="text-white">{selectedRewardName}</span>
                 </p>
                 <p className="mt-1 text-xs text-gray-500">
                   {t("form.id")} {selectedRewardId}
                 </p>
                 {/* Issue #393再設計: メイン報酬に紐付けるカードパック。パック管理
                     (カード管理画面)で事前登録した一覧から選ぶだけで、ここでは
                     もうゲート対象外(新規登録はパック管理モーダル側でのみ発生)。
                     Issue #554: canManage=false のときは表示自体を制御する
                     (mainPackControlMode参照)。 */}
                 {mainPackControlMode === "hidden" ? (
                   renderPackUpsellHint()
                 ) : (
                   <>
                     <label className="mt-3 block text-xs text-gray-300">
                       {t("collections.mainLabel")}
                       <select
                         value={selectedCollectionName}
                         onChange={(e) => setSelectedCollectionName(e.target.value)}
                         disabled={mainPackControlMode === "disabled"}
                         className="mt-1 h-9 w-full rounded-md border border-gray-600 bg-gray-800 px-3 text-sm text-gray-100 transition-colors hover:border-gray-500 focus:border-purple-500 focus:outline-none focus:ring-1 focus:ring-purple-500/40 disabled:cursor-not-allowed disabled:opacity-60"
                       >
                         <option value="">{t("collections.all")}</option>
                         {/* Issue #555: 「デフォルトパックのみ」= 未分類(collection_name
                             IS NULL)のカードだけに抽選対象を絞る選択肢。事前登録された
                             パックとは独立した固定オプションとして常に表示する。 */}
                         <option value={DEFAULT_PACK_SENTINEL}>
                           {t("collections.defaultOnly", { name: defaultPackDisplayName })}
                         </option>
                         {collections.map((name) => (
                           <option key={name} value={name}>{name}</option>
                         ))}
                         {/* 保存済みだが一覧に無い(パック管理で登録解除された)パックも
                             選択肢に残し、黙ってスコープが全カードに変わる事故を防ぐ。
                             #393再設計後、この一覧は「事前登録済みパック名」のみを
                             返す(アクティブカードの有無は問わない)ため、ここに来る
                             ケースは常に「登録解除済み」であり「抽選可能カードなし」
                             ではない。取得完了後のみラベルを付す
                             （取得前/失敗時は素の名前で表示）。
                             Issue #555: DEFAULT_PACK_SENTINEL は上の固定オプションと
                             して既に選択肢にあるため、ここでは除外する(除外しないと
                             同じ値のoptionが2つ並び、誤って「登録解除済み」ラベルの
                             方が選択されてしまう)。 */}
                         {selectedCollectionName
                           && selectedCollectionName !== DEFAULT_PACK_SENTINEL
                           && !collections.includes(selectedCollectionName) && (
                           <option value={selectedCollectionName}>
                             {collectionsLoaded
                               ? t("collections.missing", { name: selectedCollectionName })
                               : selectedCollectionName}
                           </option>
                         )}
                       </select>
                     </label>
                     <p className="mt-1 text-xs text-gray-400">
                       {t("collections.help")}
                     </p>
                     {mainPackControlMode === "disabled" && renderPackUpsellHint()}
                     {mainPackControlMode === "enabled" && showNoPacksRegisteredHint && (
                       <p className="mt-1 text-xs text-gray-500">{t("collections.packHint")}</p>
                     )}
                   </>
                 )}
               </div>
             )}
           </SectionCard>

           {/* Additional Rewards Section - Only shown when main reward is active */}
           {/* 追加報酬セクション - メイン報酬がアクティブな場合のみ表示。
               Issue #556: 見出し・説明は SectionCard 側で描画する(二重見出しの
               防止のため、旧マークアップの内部 h3/p は削除)。 */}
           {!compact && selectedRewardId && eventSubStatus === "active" && (
             <SectionCard
               title={t("additionalRewards.title")}
               description={t("additionalRewards.description")}
             >
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
                           {/* Issue #393再設計: 紐付くカードパック。パック管理で
                               登録解除された(=事前登録一覧に無い)パックは警告色で
                               示す。取得完了後のみ警告（取得前/失敗時は素の名前で表示）。
                               Issue #555: DEFAULT_PACK_SENTINEL は予約値のため
                               事前登録一覧には現れず、素の "__default__" 文字列
                               表示や「登録解除済み」誤判定を避けるため専用ラベルを
                               優先して表示する。 */}
                           {reward.collection_name ? (
                             reward.collection_name === DEFAULT_PACK_SENTINEL ? (
                               <span className="rounded bg-gray-700 px-2 py-0.5 text-gray-200">
                                 {t("collections.defaultOnly", { name: defaultPackDisplayName })}
                               </span>
                             ) : collectionsLoaded && !collections.includes(reward.collection_name) ? (
                               <span className="rounded bg-amber-500/20 px-2 py-0.5 text-amber-200">
                                 {t("collections.missing", { name: reward.collection_name })}
                               </span>
                             ) : (
                               <span className="rounded bg-gray-700 px-2 py-0.5 text-gray-200">
                                 {reward.collection_name}
                               </span>
                             )
                           ) : (
                             <span className="rounded bg-gray-700 px-2 py-0.5 text-gray-200">
                               {t("collections.all")}
                             </span>
                           )}
                         </div>
                       </div>
                       <button
                         onClick={() => handleRemoveAdditionalReward(reward.reward_id)}
                         disabled={isMaintenanceBlocked}
                         title={isMaintenanceBlocked ? tMaintenance("writeDisabled") : undefined}
                         className="text-xs text-red-400 hover:text-red-300 disabled:cursor-not-allowed disabled:opacity-50"
                       >
                         {t("additionalRewards.remove")}
                       </button>
                     </div>
                   ))}
                 </div>
               )}

               {/* Add new additional reward */}
               {/* 新しい追加報酬を追加 */}
               <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_160px_180px_auto] sm:items-center">
                 {/*
                   ネイティブの矢印アイコンを残しつつ右側に余白を確保。
                   bg-gray-700 で他のフォーム要素と階調を揃え、フォーカスリングで状態を明示する。
                 */}
                 <select
                   value={selectedAdditionalRewardId}
                   onChange={(e) => setSelectedAdditionalRewardId(e.target.value)}
                   className="h-10 min-w-0 rounded-md border border-gray-600 bg-gray-700 px-3 text-sm text-gray-100 transition-colors hover:border-gray-500 focus:border-purple-500 focus:outline-none focus:ring-1 focus:ring-purple-500/40"
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
                 {/* Issue #393再設計: この追加報酬に紐付けるカードパック（任意）。
                     パック管理で事前登録した一覧から選ぶだけで、ここではゲート
                     対象外(報酬自体の新規作成は常に可能)。
                     Issue #554: canManage=false かつ紐付けなしの場合、グリッド
                     レイアウトを崩さないよう同じセル内に短い案内テキストを表示し、
                     詳しい案内(リンク付き)はグリッド全体の下に別途表示する。 */}
                 {additionalPackControlMode === "hidden" ? (
                   <div className="flex h-10 min-w-0 items-center rounded-md border border-gray-700 bg-gray-800/60 px-2 text-[11px] leading-tight text-gray-500">
                     {t("collections.premiumLocked")}
                   </div>
                 ) : (
                   <select
                     value={selectedAdditionalCollectionName}
                     onChange={(e) => setSelectedAdditionalCollectionName(e.target.value)}
                     aria-label={t("collections.additionalLabel")}
                     disabled={additionalPackControlMode === "disabled"}
                     className="h-10 min-w-0 rounded-md border border-gray-600 bg-gray-700 px-3 text-sm text-gray-100 transition-colors hover:border-gray-500 focus:border-purple-500 focus:outline-none focus:ring-1 focus:ring-purple-500/40 disabled:cursor-not-allowed disabled:opacity-60"
                   >
                     <option value="">{t("collections.all")}</option>
                     {/* Issue #555: メイン報酬の選択肢と同様に「デフォルトパックのみ」を追加 */}
                     <option value={DEFAULT_PACK_SENTINEL}>
                       {t("collections.defaultOnly", { name: defaultPackDisplayName })}
                     </option>
                     {collections.map((name) => (
                       <option key={name} value={name}>{name}</option>
                     ))}
                   </select>
                 )}
                 {/*
                   ラベルと数値入力を1コンポーネントとして見せるためのコンテナ。
                   focus-within で内側 input のフォーカスに合わせてコンテナを強調する。
                 */}
                 <label className="group flex h-10 items-center gap-2 rounded-md border border-gray-600 bg-gray-700 pl-3 pr-1.5 text-sm text-gray-200 transition-colors hover:border-gray-500 focus-within:border-purple-500 focus-within:ring-1 focus-within:ring-purple-500/40">
                   <span className="whitespace-nowrap text-xs text-gray-300">
                     {t("additionalRewards.drawCount")}
                   </span>
                   <input
                     type="number"
                     min={1}
                     max={15}
                     value={additionalDrawCount}
                     // Issue #641: onChange clamp must match the `max` attribute above,
                     // otherwise keyboard-entered values beyond the old 10 cap would be
                     // silently truncated back down (max alone doesn't block typed input).
                     onChange={(e) => setAdditionalDrawCount(Math.min(15, Math.max(1, Number(e.target.value) || 1)))}
                     className="h-7 w-12 rounded bg-gray-800 px-2 text-sm text-gray-100 focus:outline-none"
                   />
                 </label>
                 <button
                   onClick={handleAddAdditionalReward}
                   disabled={addingAdditional || !selectedAdditionalRewardId || isMaintenanceBlocked}
                   title={isMaintenanceBlocked ? tMaintenance("writeDisabled") : undefined}
                   className="inline-flex h-10 items-center justify-center rounded-md bg-purple-600 px-4 text-sm font-medium text-white shadow-sm transition-colors hover:bg-purple-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-400 focus-visible:ring-offset-2 focus-visible:ring-offset-gray-700 disabled:cursor-not-allowed disabled:bg-gray-600 disabled:text-gray-400 disabled:shadow-none"
                 >
                   {addingAdditional ? tCommon("loading") : tCommon("add")}
                 </button>
               </div>
               {(additionalPackControlMode === "hidden" || additionalPackControlMode === "disabled") &&
                 renderPackUpsellHint()}
               {additionalPackControlMode === "enabled" && showNoPacksRegisteredHint && (
                 <p className="mt-1 text-xs text-gray-500">{t("collections.packHint")}</p>
               )}
             </SectionCard>
           )}

           {/* Issue #556: レイドガチャセクション。従来は追加報酬パネル内部の
               1ブロック(一覧と追加フォームの間)に挟み込まれていて機能の境界が
               分かりづらかったため、専用セクションとして独立させた。
               タイトル・説明は SectionCard 側で描画する(旧マークアップの
               インラインタイトル/説明は重複するため削除)。
               表示条件(メイン報酬がアクティブな場合のみ)は追加報酬セクションと
               同一のまま変更していない。 */}
           {!compact && selectedRewardId && eventSubStatus === "active" && (
             <SectionCard
               title={t("additionalRewards.raidGiftTitle")}
               description={t("additionalRewards.raidGiftDescription")}
             >
               <div className="flex items-center gap-2">
                 {/* 可視タイトルは SectionCard の見出しに移したため、入力単体の
                     意味(何の枚数か)を伝える aria-label を付与する。追加報酬
                     フォームの枚数入力(drawCount)と同文言にすると accessible
                     name が重複し、将来 getByLabelText で多重一致する回帰リスク
                     があるため、レイドガチャ専用キー(raidGiftCountLabel)を使う。 */}
                 <input
                   type="number"
                   min={0}
                   max={15}
                   aria-label={t("additionalRewards.raidGiftCountLabel")}
                   value={raidGiftDrawCount}
                   // Issue #641: onChange clamp must match the `max` attribute above,
                   // otherwise keyboard-entered values beyond the old 10 cap would be
                   // silently truncated back down (max alone doesn't block typed input).
                   onChange={(e) => setRaidGiftDrawCount(Math.min(15, Math.max(0, Number(e.target.value) || 0)))}
                   className="h-9 w-16 rounded-md border border-gray-600 bg-gray-700 px-2 text-sm text-gray-100 transition-colors hover:border-gray-500 focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500/40"
                 />
                 <button
                   type="button"
                   onClick={updateRaidGiftSettings}
                   disabled={updatingRaidGift || isMaintenanceBlocked}
                   title={isMaintenanceBlocked ? tMaintenance("writeDisabled") : undefined}
                   className="inline-flex h-9 items-center justify-center rounded-md bg-cyan-600 px-3 text-xs font-medium text-white shadow-sm transition-colors hover:bg-cyan-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:ring-offset-2 focus-visible:ring-offset-gray-800 disabled:cursor-not-allowed disabled:bg-gray-600 disabled:text-gray-400 disabled:shadow-none"
                 >
                   {updatingRaidGift ? tCommon("loading") : tCommon("save")}
                 </button>
               </div>
             </SectionCard>
           )}

           {/* Issue #556: 詳細モードではセクション群と全体アクション行の境界を
               hairline(border-t)で明示する。compact 時は従来クラスをそのまま
               維持し、シンプルモードの見た目を変えない。 */}
           <div className={compact ? "flex flex-wrap items-center gap-3" : "flex flex-wrap items-center gap-3 border-t border-gray-700 pt-4"}>
             {/*
               主アクション・補助アクション・破壊的アクションの3階層をボタンの塗り/枠線/赤系で表現する。
               全ボタン h-10 で高さを揃え、横並びの安定感を確保する。
             */}
             <button
               onClick={handleSave}
               disabled={saving || !selectedRewardId || isMaintenanceBlocked}
               title={isMaintenanceBlocked ? tMaintenance("writeDisabled") : undefined}
               className="inline-flex h-10 items-center justify-center whitespace-nowrap rounded-md bg-purple-600 px-5 text-sm font-medium text-white shadow-sm transition-colors hover:bg-purple-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-400 focus-visible:ring-offset-2 focus-visible:ring-offset-gray-800 disabled:cursor-not-allowed disabled:bg-gray-600 disabled:text-gray-400 disabled:shadow-none"
             >
               {saving ? tCommon("loading") : t("buttons.saveEventSub")}
             </button>
             {!compact && (
             <button
               onClick={() => { fetchRewards(); fetchEventSubStatus(); fetchAdditionalRewards(); fetchRaidGachaStatus(); setRegistrationFailed(false); }}
               className="inline-flex h-10 items-center justify-center rounded-md border border-gray-500 bg-transparent px-4 text-sm font-medium text-gray-200 transition-colors hover:border-gray-400 hover:bg-gray-700/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-400 focus-visible:ring-offset-2 focus-visible:ring-offset-gray-800"
             >
               {tCommon("refresh")}
             </button>
             )}
             {/* 設定解除ボタン: EventSubが設定されている場合のみ表示 (compact 時は省略) */}
             {!compact && (eventSubStatus === "active" || eventSubStatus === "pending" || subscriptions.length > 0) && (
               <button
                 onClick={handleDisconnect}
                 disabled={disconnecting || isMaintenanceBlocked}
                 title={isMaintenanceBlocked ? tMaintenance("writeDisabled") : undefined}
                 className="inline-flex h-10 items-center justify-center rounded-md border border-red-500/70 bg-transparent px-4 text-sm font-medium text-red-300 transition-colors hover:border-red-400 hover:bg-red-500/15 hover:text-red-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-400 focus-visible:ring-offset-2 focus-visible:ring-offset-gray-800 disabled:cursor-not-allowed disabled:opacity-50"
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

/**
 * Issue #556: 詳細モード用のセクションカード。
 * 非compact表示では機能ブロック(接続状況/メイン報酬/追加報酬/レイドガチャ)を
 * 見出し+説明文付きの枠(border)で視覚的に区切り、約1300行分の設定UIが平坦に
 * 縦積みされて機能の境界が判別しづらかった問題を解消する。
 *
 * compact=true(シンプルモード)では枠・見出しを一切描画せず、children を
 * フラグメントとしてそのまま返す。フラグメントは DOM ノードを生成しないため、
 * 外側コンテナの space-y-* セレクタ(直下の子への margin 適用)も再構成前と
 * 同じ要素に効き、シンプルモードの DOM 構造・見た目は完全に維持される
 * (「compact モードの見た目は変えない」制約を機械的に保証する)。
 *
 * Section card for the advanced (non-compact) mode. Wraps each functional
 * block in a bordered card with a heading + description. In compact mode it
 * renders children as-is (fragment), keeping the simple-mode DOM identical.
 */
function SectionCard({
  title,
  description,
  compact = false,
  children,
}: {
  title: string;
  description?: string;
  compact?: boolean;
  children: React.ReactNode;
}) {
  // aria-labelledby 用の一意ID。early return より前に呼び、フックの呼び出し
  // 順序を全レンダーで一定に保つ(rules of hooks)。compact 時は未使用。
  const headingId = useId();
  if (compact) return <>{children}</>;
  return (
    <section
      aria-labelledby={headingId}
      className="rounded-lg border border-gray-700 bg-gray-900/30 p-4"
    >
      <h3 id={headingId} className="text-sm font-semibold text-gray-100">{title}</h3>
      {description && <p className="mt-1 text-xs text-gray-400">{description}</p>}
      {/* space-y-4: セクション内の直下ブロック(報酬select/フォールバック/選択中
          情報など)の縦リズムを統一する。再構成前は外側コンテナの space-y-4 が
          担っていた間隔で、同じ 1rem を維持している。 */}
      <div className="mt-4 space-y-4">{children}</div>
    </section>
  );
}
