"use client";

import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { useTranslations } from "next-intl";
import { logger } from "@/lib/logger";
import { RARITIES, SOUND_UPLOAD_CONFIG } from "@/lib/constants";
import {
  createRuleId,
  legacySoundToRules,
  normalizeGachaSoundRules,
  type GachaSoundRule,
  type GachaSoundTargetType,
} from "@/lib/gacha-sound-rules";
import type { Json } from "@/types/database";
import type { PlanType } from "@/lib/plan-constants";
import { parseMaintenanceError } from "@/lib/maintenance/client";
import { useMaintenanceStatus } from "./MaintenanceStatusProvider";

// Issue #586: 報酬別ルールの対象選択に使うTwitchチャネルポイント報酬の最小形状。
// 同じ形状の interface が src/components/ChannelPointSettings.tsx と
// src/app/api/twitch/channel-point-bootstrap/route.ts にも独立して存在する
// (既存の踏襲パターン — 3箇所目の重複は、共有モジュール化するほどの複雑さが
// ないため許容する)。
interface TwitchReward {
  id: string;
  title: string;
  cost: number;
  is_enabled: boolean;
}

// 報酬一覧の取得状態。「reward」ターゲット選択UIをセレクトボックスにするか、
// 生ID入力にフォールバックするかを決める。
// - idle: 未取得（isPremiumでない、またはマウント直後）
// - loading: 取得中
// - loaded: 取得成功（0件でもセレクトを表示する — 空はエラーではない）
// - error: 取得失敗（Twitch APIエラー・未アフィリエイト等）。生ID入力にフォールバック
type RewardsFetchStatus = "idle" | "loading" | "loaded" | "error";

interface GachaSoundSettingsProps {
  streamerId: string;
  plan: PlanType;
  currentSoundUrl: string | null;
  currentSoundEnabled: boolean;
  currentSoundRules?: Json;
  currentRewardId?: string | null;
  currentRewardName?: string | null;
}

export default function GachaSoundSettings({
  streamerId,
  plan,
  currentSoundUrl,
  currentSoundEnabled,
  currentSoundRules,
  currentRewardId,
  currentRewardName,
}: GachaSoundSettingsProps) {
  const t = useTranslations("gachaSoundSettings");
  const isPremium = plan !== "basic";
  const tCommon = useTranslations("common");
  const tMaintenance = useTranslations("maintenance");
  // #694 Stage 6c: ダッシュボード共有Context経由のmaintenance状態。
  // 各書き込みのたびに個別fetchしない設計（MaintenanceStatusProvider参照）。
  const { mode: maintenanceMode } = useMaintenanceStatus();
  const isMaintenanceBlocked = maintenanceMode !== "off";

  const initialRules = useMemo(() => {
    const rules = normalizeGachaSoundRules(currentSoundRules);
    return rules.length > 0 ? rules : legacySoundToRules(currentSoundUrl, currentSoundEnabled);
  }, [currentSoundEnabled, currentSoundRules, currentSoundUrl]);

  const [rules, setRules] = useState<GachaSoundRule[]>(initialRules);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [isError, setIsError] = useState(false);

  // Issue #586: 「チャネルポイント報酬別」ルールの対象をIDの手入力ではなく
  // 一覧から選べるようにする。ChannelPointSettings と同じ
  // GET /api/twitch/rewards を叩く（あちらは診断情報込みの
  // /api/twitch/channel-point-bootstrap を使うが、ここでは報酬一覧だけで
  // 十分なため、より軽量な専用エンドポイントを使う）。
  const [rewards, setRewards] = useState<TwitchReward[]>([]);
  const [rewardsStatus, setRewardsStatus] = useState<RewardsFetchStatus>("idle");

  const audioRefs = useRef<Record<string, HTMLAudioElement | null>>({});
  const fileInputRef = useRef<HTMLInputElement>(null);

  const enabledRule = rules.find((rule) => rule.enabled);

  // Issue #946: 複数効果音・ターゲット指定(レアリティ/報酬別)は支援プラン以上限定の
  // 機能だが、単一の効果音(targetType==="all")は全プランで設定できる。
  // basicプランでは既に1件あれば追加をブロックする(サーバー側の
  // gachaSoundRulesPremiumRequired ゲートと対になる、UI側の事前ガード)。
  const canAddSound = isPremium || rules.length === 0;

  // basicプランでは効果音ルールUI全体が inert（操作不可）になるため、
  // 取得しても無駄になるTwitch APIコールを避ける。プランがアップグレード
  // されて isPremium が true になった時点で改めて取得する。
  useEffect(() => {
    if (!isPremium) return;

    let cancelled = false;
    setRewardsStatus("loading");

    (async () => {
      try {
        const response = await fetch("/api/twitch/rewards", { credentials: "include" });
        if (!response.ok) {
          if (!cancelled) setRewardsStatus("error");
          return;
        }
        const data = await response.json();
        if (cancelled) return;
        setRewards(Array.isArray(data) ? data : []);
        setRewardsStatus("loaded");
      } catch (error) {
        logger.error("Failed to fetch channel point rewards for sound rules:", error);
        if (!cancelled) setRewardsStatus("error");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isPremium]);

  const saveRules = useCallback(async (nextRules: GachaSoundRule[]) => {
    // #694 Stage 6c: 各書き込みUI(ルール切替・削除・アップロード)自体はinertで
    // disableしているが、CardManager.handleSubmitと同じ方針で送信経路の先頭
    // でも二重にガードする。
    if (isMaintenanceBlocked) {
      setMessage(tMaintenance("writeDisabled"));
      setIsError(true);
      return false;
    }
    setSaving(true);
    try {
      const response = await fetch("/api/streamer/settings", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          streamerId,
          gachaSoundRules: nextRules,
        }),
      });

      const data = await response.json().catch(() => null);

      if (!response.ok) {
        // maintenance mode による503拒否ならサーバーの案内文言を優先する
        // （事前disableをすり抜けた場合のフォールバック表示）。
        const maintenanceError = parseMaintenanceError(response, data);
        setMessage(maintenanceError?.message || data?.error || t("errors.saveFailed"));
        setIsError(true);
        return false;
      }

      // F5(#451フォローアップ): 200が返っていても、サーバー側の正規化
      // (不正URL除外・デッドルール除外・件数上限)やデプロイ窓での書き込み
      // スキップにより、実際に永続化された値が送信した nextRules と
      // 食い違うことがある。送信値をそのまま楽観反映すると、UIだけ
      // 「保存できた」体のまま実態とズレて残ってしまう(サイレント欠損)。
      // cardPackNames/packRarityWeights と同じパターンで、サーバーが
      // エコーバックした実際の永続値から state を再同期する。
      const persisted = Array.isArray(data?.gachaSoundRules)
        ? normalizeGachaSoundRules(data.gachaSoundRules)
        : nextRules;
      setRules(persisted);

      if (data?.gachaSoundRulesSkippedDeployWindow) {
        // デプロイ窓で gacha_sound_rules 列自体への書き込みが見送られた
        // (実際にはルール保存されていない)ケース。成功扱いにはせず、
        // 他のフィールドの deploy-window 案内と同様にユーザーへ知らせる。
        setMessage(t("errors.deployWindow"));
        setIsError(true);
        return false;
      }

      // Issue #946: basicプランの制限（1件・targetType==="all"のみ）を超える
      // ルールがサーバー側で保存されず落とされた場合。上のsetRules(persisted)で
      // 実際に保存された内容へは既に再同期済みなので、ここでは「一部が保存されな
      // かった」ことをユーザーへ知らせるだけでよい。
      if (data?.gachaSoundRulesPremiumRequired) {
        setMessage(t("premiumRequired"));
        setIsError(true);
        return false;
      }

      return true;
    } catch (error) {
      logger.error("Save sound rules error:", error);
      setMessage(t("errors.saveFailed"));
      setIsError(true);
      return false;
    } finally {
      setSaving(false);
    }
  }, [streamerId, t, tMaintenance, isMaintenanceBlocked]);

  const updateRule = useCallback(async (id: string, patch: Partial<GachaSoundRule>) => {
    const nextRules = rules.map((rule) => {
      if (rule.id !== id) return rule;
      const next = { ...rule, ...patch };
      if (patch.targetType === "all") {
        next.rarity = null;
        next.rewardId = null;
        next.rewardName = null;
      }
      if (patch.targetType === "rarity") {
        next.rewardId = null;
        next.rewardName = null;
        next.rarity = next.rarity ?? "common";
      }
      if (patch.targetType === "reward") {
        next.rarity = null;
        next.rewardId = next.rewardId ?? currentRewardId ?? "";
        next.rewardName = next.rewardName ?? currentRewardName ?? null;
      }
      return next;
    });

    const success = await saveRules(nextRules);
    if (success) {
      setMessage(t("messages.saved"));
      setIsError(false);
    }
  }, [currentRewardId, currentRewardName, rules, saveRules, t]);

  const handleFileUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.size > SOUND_UPLOAD_CONFIG.MAX_FILE_SIZE) {
      setMessage(t("errors.fileTooLarge"));
      setIsError(true);
      return;
    }

    const allowedTypes = SOUND_UPLOAD_CONFIG.ALLOWED_TYPES as readonly string[];
    if (!allowedTypes.includes(file.type)) {
      setMessage(t("errors.invalidFileType"));
      setIsError(true);
      return;
    }

    // #694 Stage 6c: ファイル入力自体はinertでdisableしているが、送信経路の
    // 先頭でも二重にガードする（saveRulesと同じ方針）。
    if (isMaintenanceBlocked) {
      setMessage(tMaintenance("writeDisabled"));
      setIsError(true);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
      return;
    }

    setUploading(true);
    setMessage("");
    setIsError(false);

    try {
      const formData = new FormData();
      formData.append("file", file);

      const response = await fetch("/api/upload/sound", {
        method: "POST",
        credentials: "include",
        body: formData,
      });

      if (!response.ok) {
        const errorData = await response.json();
        // maintenance mode による503拒否ならサーバーの案内文言を優先する。
        const maintenanceError = parseMaintenanceError(response, errorData);
        setMessage(maintenanceError?.message || errorData.error || (response.status === 429 ? t("errors.rateLimit") : t("errors.uploadFailed")));
        setIsError(true);
        return;
      }

      const data = await response.json();
      const nextRules: GachaSoundRule[] = [
        ...rules,
        {
          id: createRuleId(),
          url: data.url,
          enabled: true,
          label: file.name.replace(/\.[^.]+$/, "").slice(0, 80) || t("form.defaultLabel"),
          targetType: "all",
          rarity: null,
          rewardId: null,
          rewardName: null,
        },
      ];

      const success = await saveRules(nextRules);
      if (success) {
        setMessage(t("messages.uploadSuccess"));
        setIsError(false);
      }
    } catch (error) {
      logger.error("Sound upload error:", error);
      setMessage(t("errors.uploadFailed"));
      setIsError(true);
    } finally {
      setUploading(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  }, [rules, saveRules, t, tMaintenance, isMaintenanceBlocked]);

  const handleDelete = useCallback(async (rule: GachaSoundRule) => {
    if (!confirm(t("confirmDelete"))) return;

    // #694 Stage 6c: 削除ボタン自体はinertでdisableしているが、送信経路の
    // 先頭でも二重にガードする（saveRulesと同じ方針）。
    if (isMaintenanceBlocked) {
      setMessage(tMaintenance("writeDisabled"));
      setIsError(true);
      return;
    }

    setDeletingId(rule.id);
    setMessage("");
    setIsError(false);

    try {
      const deleteResponse = await fetch("/api/upload/sound", {
        method: "DELETE",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: rule.url }),
      });

      if (!deleteResponse.ok) {
        const errorData = await deleteResponse.json();
        // maintenance mode による503拒否ならサーバーの案内文言を優先する。
        const maintenanceError = parseMaintenanceError(deleteResponse, errorData);
        setMessage(maintenanceError?.message || errorData.error || t("errors.deleteFailed"));
        setIsError(true);
        return;
      }

      const success = await saveRules(rules.filter((item) => item.id !== rule.id));
      if (success) {
        setMessage(t("messages.deleted"));
        setIsError(false);
      }
    } catch (error) {
      logger.error("Delete sound error:", error);
      setMessage(t("errors.deleteFailed"));
      setIsError(true);
    } finally {
      setDeletingId(null);
    }
  }, [rules, saveRules, t, tMaintenance, isMaintenanceBlocked]);

  const handlePlayPreview = useCallback((id: string) => {
    const audio = audioRefs.current[id];
    if (!audio) return;
    audio.currentTime = 0;
    audio.play().catch((error) => {
      logger.error("Audio play error:", error);
    });
  }, []);

  const handleStopPreview = useCallback((id: string) => {
    const audio = audioRefs.current[id];
    if (!audio) return;
    audio.pause();
    audio.currentTime = 0;
  }, []);

  return (
    <div className="rounded-xl bg-gray-800 p-6">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="text-xl font-semibold text-white">{t("title")}</h2>
        <span className={`inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs ${
          enabledRule ? "bg-green-500/20 text-green-400" : "bg-gray-500/20 text-gray-400"
        }`}>
          <span className={`h-2 w-2 rounded-full ${enabledRule ? "bg-green-500" : "bg-gray-500"}`} />
          {enabledRule ? t("status.enabled") : t("status.disabled")}
        </span>
      </div>

      <p className="mb-4 text-sm text-gray-400">{t("description")}</p>

      {!isPremium && (
        <p className="mb-4 rounded-lg bg-yellow-500/10 px-4 py-3 text-sm text-yellow-300">
          {t("premiumRequired")}
        </p>
      )}

      {isMaintenanceBlocked && (
        <p className="mb-4 text-sm text-yellow-400">{tMaintenance("writeDisabled")}</p>
      )}

      {/* #694 Stage 6c: maintenance中は書き込みUI（アップロード・ルール編集・削除）
          を丸ごと無効化する。Issue #946: basicプランは「1件のみ・all対象」の制限は
          あるが機能自体は使えるため、!isPremium はここでは無効化条件にしない
          （プラン制限は canAddSound / targetType select の個別 disabled で表現する）。 */}
      <div className={`space-y-4 ${isMaintenanceBlocked ? "opacity-50" : ""}`} inert={isMaintenanceBlocked || undefined}>
        <div>
          <label className="mb-1 block text-sm text-gray-300">{t("form.selectFile")}</label>
          <input
            ref={fileInputRef}
            type="file"
            accept={SOUND_UPLOAD_CONFIG.ALLOWED_EXTENSIONS.map(ext => `.${ext}`).join(",")}
            onChange={handleFileUpload}
            disabled={uploading || isMaintenanceBlocked || !canAddSound}
            title={
              isMaintenanceBlocked
                ? tMaintenance("writeDisabled")
                : !canAddSound
                  ? t("premiumRequired")
                  : undefined
            }
            className="block w-full text-sm text-gray-400 file:mr-4 file:rounded-lg file:border-0 file:bg-purple-600 file:px-4 file:py-2 file:text-sm file:font-medium file:text-white hover:file:bg-purple-700 file:disabled:opacity-50"
          />
          <p className="mt-1 text-xs text-gray-500">
            {t("form.fileRequirements", {
              formats: SOUND_UPLOAD_CONFIG.ALLOWED_EXTENSIONS.map(ext => ext.toUpperCase()).join(", "),
              maxSize: "1MB",
            })}
          </p>
        </div>

        {rules.length === 0 && (
          <p className="rounded-lg bg-gray-700/60 p-3 text-sm text-gray-400">{t("form.noSounds")}</p>
        )}

        {rules.map((rule) => (
          <div key={rule.id} className="space-y-3 rounded-lg bg-gray-700 p-4">
            <audio ref={(element) => { audioRefs.current[rule.id] = element }} src={rule.url} preload="metadata" />
            <div className="grid gap-3 md:grid-cols-[1fr_auto]">
              <input
                value={rule.label}
                onChange={(event) => setRules(current => current.map(item => item.id === rule.id ? { ...item, label: event.target.value } : item))}
                onBlur={(event) => updateRule(rule.id, { label: event.target.value.trim() || t("form.defaultLabel") })}
                className="min-w-0 rounded-lg bg-gray-800 px-3 py-2 text-sm text-white"
                aria-label={t("form.soundName")}
              />
              <label className="flex items-center gap-2 text-sm text-gray-300">
                <input
                  type="checkbox"
                  checked={rule.enabled}
                  onChange={(event) => updateRule(rule.id, { enabled: event.target.checked })}
                  className="h-4 w-4 rounded border-gray-500 bg-gray-800"
                />
                {t("form.enableSound")}
              </label>
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              {/* Issue #946: ターゲット指定(rarity/reward)は支援プラン以上限定の機能。
                  basicプランでは常に"all"のままにするため選択そのものを無効化する
                  （サーバー側もbasicプランでは"all"以外のルールを保存しない）。 */}
              <select
                value={rule.targetType}
                onChange={(event) => updateRule(rule.id, { targetType: event.target.value as GachaSoundTargetType })}
                disabled={!isPremium}
                title={!isPremium ? t("premiumRequired") : undefined}
                className="rounded-lg bg-gray-800 px-3 py-2 text-sm text-white disabled:opacity-50"
                aria-label={t("form.targetType")}
              >
                <option value="all">{t("targets.all")}</option>
                <option value="rarity">{t("targets.rarity")}</option>
                <option value="reward">{t("targets.reward")}</option>
              </select>

              {rule.targetType === "rarity" && (
                <select
                  value={rule.rarity ?? "common"}
                  onChange={(event) => updateRule(rule.id, { rarity: event.target.value as GachaSoundRule["rarity"] })}
                  className="rounded-lg bg-gray-800 px-3 py-2 text-sm text-white"
                  aria-label={t("form.rarity")}
                >
                  {RARITIES.map((rarity) => (
                    <option key={rarity.value} value={rarity.value}>{rarity.label}</option>
                  ))}
                </select>
              )}

              {/* Issue #586: 報酬IDの生入力は「変更しようがない」不具合だったため、
                  ChannelPointSettings と同じ /api/twitch/rewards から取得した
                  一覧をセレクトボックスとして表示する。取得に失敗した場合
                  （Twitch APIエラー・未アフィリエイト等）のみ、従来どおりの
                  生ID入力にフォールバックし、機能が使用不能にならないようにする。 */}
              {rule.targetType === "reward" && (
                rewardsStatus === "loaded" ? (
                  <select
                    value={rule.rewardId ?? ""}
                    onChange={(event) => {
                      const nextRewardId = event.target.value;
                      const matchedReward = rewards.find((reward) => reward.id === nextRewardId);
                      updateRule(rule.id, {
                        // 空選択("--報酬を選択--") = 未設定。normalizeGachaSoundRules側で
                        // reward対象なのにrewardIdが空のルールは「デッドルール」として
                        // 除外される既存仕様をそのまま踏襲する。
                        rewardId: nextRewardId || null,
                        rewardName: matchedReward
                          ? matchedReward.title
                          // 選択値が変わっていない(孤立IDを選び直しただけ)場合は
                          // キャッシュ済みの表示名を保持する。
                          : nextRewardId === rule.rewardId
                            ? rule.rewardName
                            : null,
                      });
                    }}
                    className="min-w-0 rounded-lg bg-gray-800 px-3 py-2 text-sm text-white"
                    aria-label={t("form.reward")}
                  >
                    <option value="">{t("form.rewardUnset")}</option>
                    {rewards.map((reward) => (
                      <option key={reward.id} value={reward.id}>
                        {reward.title} ({reward.cost} {t("options.points")})
                        {!reward.is_enabled && t("options.disabled")}
                      </option>
                    ))}
                    {/* Issue #586: 取得した一覧に無い(Twitch側で削除済みの)報酬IDが
                        既に設定されている場合、選択肢から消してしまうと配信者が
                        気づかないうちにルールが無効化される。孤立IDのまま選択肢
                        として残し、既存の紐付けを維持する
                        （CardManager/ChannelPointSettingsの孤立パック表示と同じ方針）。 */}
                    {rule.rewardId && !rewards.some((reward) => reward.id === rule.rewardId) && (
                      <option value={rule.rewardId}>
                        {t("form.rewardMissing", { name: rule.rewardName || rule.rewardId })}
                      </option>
                    )}
                  </select>
                ) : (
                  <div>
                    <input
                      value={rule.rewardId ?? ""}
                      onChange={(event) => setRules(current => current.map(item => item.id === rule.id ? { ...item, rewardId: event.target.value } : item))}
                      onBlur={(event) => updateRule(rule.id, {
                        rewardId: event.target.value.trim(),
                        rewardName: event.target.value.trim() === currentRewardId ? currentRewardName ?? null : rule.rewardName,
                      })}
                      placeholder={currentRewardId ? `${currentRewardName || "Reward"} (${currentRewardId})` : t("form.rewardPlaceholder")}
                      className="min-w-0 rounded-lg bg-gray-800 px-3 py-2 text-sm text-white"
                      aria-label={t("form.rewardId")}
                    />
                    {/* 取得失敗時のみヒントを出す。ロード中/未取得(basicプラン)では
                        単に既存の生ID入力を静かに見せる。 */}
                    {rewardsStatus === "error" && (
                      <p className="mt-1 text-xs text-yellow-500">{t("form.rewardFetchFailedHint")}</p>
                    )}
                  </div>
                )
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button onClick={() => handlePlayPreview(rule.id)} className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700">
                {t("buttons.play")}
              </button>
              <button onClick={() => handleStopPreview(rule.id)} className="rounded-lg border border-gray-600 px-3 py-1.5 text-sm text-gray-300 hover:bg-gray-600">
                {t("buttons.stop")}
              </button>
              <button
                onClick={() => handleDelete(rule)}
                disabled={deletingId === rule.id || isMaintenanceBlocked}
                title={isMaintenanceBlocked ? tMaintenance("writeDisabled") : undefined}
                className="rounded-lg bg-red-600 px-3 py-1.5 text-sm text-white hover:bg-red-700 disabled:opacity-50"
              >
                {deletingId === rule.id ? tCommon("loading") : t("buttons.delete")}
              </button>
            </div>
          </div>
        ))}

        {message && <p className={`text-sm ${isError ? "text-red-400" : "text-green-400"}`}>{message}</p>}
        {(uploading || saving) && (
          <p className="text-sm text-gray-400">{uploading ? t("messages.uploading") : t("messages.saving")}</p>
        )}
      </div>
    </div>
  );
}
