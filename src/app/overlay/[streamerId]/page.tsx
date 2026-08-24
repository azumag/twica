"use client";

import { useEffect, useLayoutEffect, useState, useCallback, useRef, type CSSProperties } from "react";
import { flushSync } from "react-dom";
import { useParams } from "next/navigation";
import Image from "next/image";
import type { Card, Rarity } from "@/types/database";
import { logger } from "@/lib/logger";
import {
  isValidOverlayHistoryId,
} from "@/lib/overlay-realtime/contract";
import { normalizeOverlayHistoryTimestamp } from "@/lib/overlay-history-cursor";
import {
  subscribeToGachaResults,
  type OverlayHistoryCursor,
} from "@/lib/realtime";
import {
  type OverlayEffectStyle,
  type OverlayEffectParticle,
  type RarityEffectMap,
  parseRarityEffectMap,
  resolveEffectForRarity,
  generateOverlayEffectParticles,
  DEFAULT_RARITY_EFFECT_MAP,
  OVERLAY_EFFECT_PARTICLE_CONFIG,
} from "@/lib/overlay-effect";
import { getRarityGlowClass, getRarityGradientClass, getRarityDisplayInfo } from "@/lib/rarity";
import { cardImageFitClass, cardImageFitStyle } from "@/lib/card-image-style";
import {
  normalizeGachaSoundRules,
  pickSoundBearingCardIndex,
  resolvePlayableGachaSound,
  type GachaSoundRule,
} from "@/lib/gacha-sound-rules";
import {
  shouldScheduleReload,
  isReloadCooldownActive,
  serializePollState,
  parsePollState,
  parseReloadCooldownRecords,
  upsertReloadCooldownRecord,
  RELOAD_COOLDOWN_MS,
  POLLSTATE_TTL_MS,
} from "@/lib/overlay-version";
import { fetchMaintenanceStatus } from "@/lib/maintenance/client";
import type { MaintenanceMode } from "@/lib/maintenance/state";

// OBSブラウザソース（古いCEF）向けのqueueMicrotaskポリフィル
// 一部のOBSバージョンではqueueMicrotaskがサポートされていないため
// setTimeoutでフォールバックする
if (typeof window !== 'undefined' && typeof window.queueMicrotask !== 'function') {
  window.queueMicrotask = (callback: () => void) => {
    Promise.resolve().then(callback).catch((err) => {
      setTimeout(() => { throw err; }, 0);
    });
  };
}

/**
 * Get rarity information (label and color) for a given rarity value
 * 指定されたレアリティ値のレアリティ情報（ラベルと色）を取得
 */
const getRarityInfo = (rarity: Rarity) => getRarityDisplayInfo(rarity);

interface GachaResult {
  card: Card;
  cards?: Card[];
  userTwitchUsername: string;
  historyId?: string;
  soundGroupId?: string;
  shouldPlaySound?: boolean;
  rewardId?: string | null;
  /** Draw identities are present for transport-backed N-draw payloads. */
  drawEventIds?: string[];
  /** Monotonic per-overlay key so consecutive draws always remount card DOM. */
  displayInstanceId?: number;
  /** Stable transport draw identity used to resume a partially rendered batch. */
  drawEventId?: string;
  /** Internal key shared by all display items from one transport batch. */
  batchKey?: string;
}

type DisplayRequest = {
  data: GachaResult;
  resolve: (accepted: boolean) => void;
};

type DisplayResultHandler = (data: GachaResult) => Promise<boolean>;

type DisplayCommitBatch = {
  batchKey: string;
  pendingIds: Set<number>;
  acceptedDrawIds: Set<string>;
  resolve: (accepted: boolean) => void;
  settled: boolean;
};

interface OverlayPollingEvent {
  id: string;
  eventId: string | null;
  redeemedAt: string;
  userTwitchUsername: string;
  card: Pick<Card, "id" | "name" | "description" | "image_url" | "rarity">;
  rewardId?: string | null;
}

function fetchJsonWithXhrFallback<T>(url: string): Promise<T> {
  return fetch(url)
    .then((response) => {
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return response.json() as Promise<T>;
    })
    .catch((fetchError) => {
      return new Promise<T>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("GET", url, true);
        xhr.responseType = "json";
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            const body = xhr.response ?? JSON.parse(xhr.responseText) as T;
            resolve(body as T);
          } else {
            reject(new Error(`HTTP ${xhr.status}`));
          }
        };
        xhr.onerror = () => reject(fetchError);
        xhr.ontimeout = () => reject(new Error("XHR timeout"));
        xhr.timeout = 10000;
        xhr.send();
      });
    });
}

/**
 * Overlay display options controlled via URL parameters
 * URLパラメータで制御されるオーバーレイ表示オプション
 * - imageOnly: 画像のみ表示（カード枠・テキストなし）
 * - autoPortrait: 縦長画像を自動検出してオリジナル画像表示
 * - effects: エフェクト表示のマスタースイッチ（デフォルト: true。false で全レアリティ無効）
 * - rarityEffectMap: レアリティ→エフェクト種別のマップ（URL `fx=` / レガシー `effect=` 由来）
 * - smallMode: 小さい画像用の縮小表示モード
 * - debug: デバッグモード（接続状態の詳細表示）
 * - portraitShowName: 縦長画像でカード名を表示（画像の下）
 * - portraitShowRarity: 縦長画像でレアリティを表示（画像の下）
 * - portraitShowDescription: 縦長画像で説明を表示（画像の下）
 * - portraitShowUsername: 縦長画像でユーザー名を表示（画像の上）
 */
interface OverlayOptions {
  imageOnly: boolean;
  autoPortrait: boolean;
  effects: boolean;
  rarityEffectMap: RarityEffectMap;
  smallMode: boolean;
  displayDuration: number;  // カードの表示時間（秒）、デフォルト6秒
  debug: boolean;
  // 縦長画像の付帯情報表示オプション（画像に被らず表示）
  portraitShowName: boolean;
  portraitShowRarity: boolean;
  portraitShowDescription: boolean;
  portraitShowUsername: boolean;
}

// Issue #569: このクライアント自身のビルドバージョン。next.config.ts の `env` 設定に
// より、process.env.NEXT_PUBLIC_OVERLAY_VERSION はビルド時にリテラル文字列として
// インライン化される(実行時にサーバーから取得するわけではない)。
// 'dev' はローカル開発時などの既定値で、shouldScheduleReload 側で意図的に
// リロード対象外として扱われる(overlay-version.ts 参照)。
const CURRENT_OVERLAY_VERSION = process.env.NEXT_PUBLIC_OVERLAY_VERSION ?? "dev";

// Issue #569: バージョン不一致検出からリロード実行までのランダムジッター上限。
// サンダリングハード回避のため、0〜この値の範囲でリロード実行タイミングを
// 散らす(checkOverlayVersion参照)。
const RELOAD_JITTER_MAX_MS = 10 * 60 * 1000;
// 演出中で実行を見送った場合の再試行間隔(演出を壊さないための待ち時間)
const RELOAD_DEFER_RETRY_MS = 30 * 1000;
// SREレビュー指摘対応: 効果音の長さ(audio.duration)が有限値で取得できない場合
// (メタデータ未ロードでNaN等)に使う「再生終了見込み」の安全上限。
// リロード延期判定(soundPlayingUntilRef)のフォールバックにのみ使う
const SOUND_DURATION_FALLBACK_MS = 15 * 1000;
// OBS Browser Source may keep a large animated image metadata request pending
// without firing either `load` or `error`. Aspect-ratio detection is
// presentation-only, so this timeout bounds the probe lifetime/layout decision;
// the business-event queue and card DOM mounting do not wait for it.
const IMAGE_METADATA_TIMEOUT_MS = 1_500;
const MIN_REVEAL_LEAD_IN_MS = 100;
// A realtime delivery is not acknowledged until React has committed the card
// and its image has loaded. A stopped CEF/OBS render loop must still release
// that promise so the transport can roll the event back and recover it through
// polling, while presentation timing remains owned by the display queue.
const DISPLAY_COMMIT_ACK_TIMEOUT_MS = 4_500;
// React normally commits the fallback in the same task as the state update,
// but OBS/CEF can coalesce timer callbacks. Give that commit a short, bounded
// grace period before treating the presentation as failed.
const DISPLAY_FALLBACK_COMMIT_GRACE_MS = 250;
const DISPLAY_FALLBACK_COMMIT_RETRY_MS = 25;
// A short display duration can expire in the same task that commits the
// fallback. Keep the painted fallback visible long enough for at least one
// browser/CEF frame before making the outgoing card transparent.
const DISPLAY_FALLBACK_MIN_VISIBLE_MS = 250;

// sessionStorage キー。リロード前後で状態を引き継ぐために使う
// Issue #634 (PR #995): 新旧コードが同じキーを奪い合わないよう"-v2"へ改称した。
// 経緯・設計判断はoverlay-version.tsのparseReloadCooldownRecords docへ集約
// (このファイルとの重複記述を避けるため、詳細説明はそちら側だけに置く)。
const RELOAD_COOLDOWN_STORAGE_KEY = "twica-overlay-reload-v2";
const POLLSTATE_STORAGE_KEY = "twica-overlay-pollstate";
// A terminal display-ACK block closes the current controller so its durable
// cursor cannot be advanced past an invisible card. One bounded page reload
// gives a transient OBS/CEF render stall a fresh controller without creating an
// infinite reload loop when the same card remains unrenderable.
const TERMINAL_RECOVERY_RELOAD_COOLDOWN_MS = 10 * 60 * 1000;
const TERMINAL_RECOVERY_RELOAD_STORAGE_KEY = "twica-overlay-terminal-recovery-v1";
const pollStateStorageKey = (streamerId: string) =>
  `${POLLSTATE_STORAGE_KEY}:${streamerId}`;

export default function OverlayPage() {
  const params = useParams();
  const streamerId = params.streamerId as string;
  const [result, setResult] = useState<GachaResult | null>(null);
  const [showCard, setShowCard] = useState(false);
  // エフェクトパーティクル（スタイルごとの出現位置・タイミング・見た目）。
  // 表示するカードのレアリティ→スタイルを解決し generateOverlayEffectParticles で生成する。
  const [effectParticles, setEffectParticles] = useState<OverlayEffectParticle[]>([]);
  // 現在表示中カードに対して解決されたエフェクトスタイル（"none" なら演出なし）。
  // レアリティ別マップ（options.rarityEffectMap）と effects スイッチから決まる。
  const [activeEffectStyle, setActiveEffectStyle] = useState<OverlayEffectStyle>("none");
  const [connectionStatus, setConnectionStatus] = useState<'connecting' | 'connected' | 'disconnected' | 'error'>('connecting');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // オーバーレイ表示オプション（URLパラメータで設定）
  // autoPortraitとsmallModeはデフォルトでtrue（より良い表示体験のため）
  const [options, setOptions] = useState<OverlayOptions>({
    imageOnly: false,
    autoPortrait: true,  // デフォルトでポートレイト画像を自動検出
    effects: true,
    // 既定は「legendary のみ sparkle」（従来挙動の非破壊維持）。URL 解析で上書きされる。
    rarityEffectMap: { ...DEFAULT_RARITY_EFFECT_MAP },
    smallMode: true,     // デフォルトで小さい画像モードを有効化
    displayDuration: 6,  // カードの表示時間（秒）、デフォルト6秒
    debug: false,        // デバッグモード（接続状態の詳細表示）
    // 縦長画像の付帯情報オプション（デフォルトでレアリティのみ表示）
    portraitShowName: false,
    portraitShowRarity: true,
    portraitShowDescription: false,
    portraitShowUsername: false,
  });
  // デバッグ用の詳細な接続ログ
  // OBSブラウザソースでの接続問題を調査するために使用
  const [debugLogs, setDebugLogs] = useState<string[]>([]);
  // #694 Stage 6b: 現在のmaintenance mode（debugパネル表示専用。通常の配信
  // オーバーレイ表示には一切使わない）。debug=true のときだけポーリングする
  // （下記useEffect参照）ため、初期値は安全側の'off'固定でよい。
  const [maintenanceMode, setMaintenanceMode] = useState<MaintenanceMode>("off");
  // 画像のアスペクト比が縦長かどうかを判定するためのState
  const [isPortraitImage, setIsPortraitImage] = useState(false);
  // 画像が小さい（400x400未満）かどうかを判定するためのState
  // 小さい画像の場合はsmallModeを自動適用するために使用
  const [isSmallImage, setIsSmallImage] = useState(false);
  // A broken or indefinitely pending card image must degrade to a visible DOM
  // card before the transport is acknowledged.  Keeping the instance id in
  // state makes the fallback an actual React commit that the commit effect can
  // observe, instead of treating a missing bitmap as a successful delivery.
  const [imageFallbackDisplayInstanceId, setImageFallbackDisplayInstanceId] = useState<number | null>(null);
  // ガチャ効果音設定
  // streamerから取得した効果音URLと有効/無効状態を保持
  const [soundSettings, setSoundSettings] = useState<{
    soundUrl: string | null;
    soundEnabled: boolean;
    soundRules: GachaSoundRule[];
  }>({ soundUrl: null, soundEnabled: true, soundRules: [] });
  const animationTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fallbackVisibilityTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const connectionStatusRef = useRef(connectionStatus);
  // A terminal display-ACK block deliberately holds the durable cursor. Do
  // not let the legacy disconnected polling loop read that same cursor with a
  // second dedupe cache, or already displayed rows could be shown twice.
  const legacyPollingSuppressedRef = useRef(false);
  // ガチャ結果キュー: アニメーション中に到着した結果をバッファし順番に表示する
  // 連続引き換え時に前のカードが消えて最後の1件しか表示されない問題を解消
  const queueRef = useRef<GachaResult[]>([]);
  // A card id can repeat within one draw. Give every queued display its own key
  // so React cannot reuse the previous card image while a new src is decoding.
  const displayInstanceSequenceRef = useRef(0);
  const isDisplayingRef = useRef(false);
  // Realtime delivery is acknowledged only after React has committed the card
  // branch to the DOM. Keeping the resolver keyed by the remount key makes the
  // transport retry a draw that was accepted by JavaScript but never became a
  // visible card (the failure mode behind the fixed-overlay black screen).
  const displayCommitResolversRef = useRef<Map<number, (accepted: boolean) => void>>(new Map());
  const displayCommitTimeoutsRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());
  const displayImageCleanupRef = useRef<Map<number, () => void>>(new Map());
  const displayCommitEntriesRef = useRef<Map<number, { batchKey: string; drawEventId: string }>>(new Map());
  const displayCommitBatchesRef = useRef<Map<string, DisplayCommitBatch>>(new Map());
  const terminalRecoveryReloadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // When a multi-draw batch partially renders and is retried, cards that were
  // already committed must not be shown twice. The transport rolls back the
  // whole batch on a negative acknowledgement, so this set bridges the retry
  // without consuming another redemption or duplicating the visible prefix.
  const committedDrawIdsRef = useRef<Set<string>>(new Set());
  const activeDisplayInstanceIdRef = useRef<number | undefined>(undefined);
  // Image metadata checks are presentation-only and run independently from the
  // display queue. Cleanup still resolves pending checks so Image callbacks do
  // not retain an obsolete card/component lifetime.
  const activeImageCheckCancelsRef = useRef<Set<() => void>>(new Set());
  const isOverlayMountedRef = useRef(false);
  // A streamer change can reuse this component instance. The queue generation
  // prevents an obsolete display task from continuing into the new subscription.
  const queueGenerationRef = useRef(0);
  // A mounted flag alone cannot distinguish a late callback from the previous
  // streamer after a route change. Every subscription closes over its own
  // generation and must match this ref before it can enqueue a card.
  const subscriptionGenerationRef = useRef(0);
  // Image metadata can resolve after the card that started it has already been
  // replaced. Only the latest card may update portrait/small presentation state.
  const imageLayoutGenerationRef = useRef(0);
  const playedSoundGroupIdsRef = useRef<Set<string>>(new Set());
  // processQueueの再帰呼び出し用ref（useCallback内で自身を参照するため）
  const processQueueRef = useRef<() => void>(() => {});
  // Reactのpassive effectが購読effectより遅れて実行される環境でも、最初の
  // realtime payloadを捨てないための一時バッファ。通常は表示handlerが
  // 購読開始前に準備されるが、OBS/CEFの初期化やReactのeffect再実行が
  // 同じフレームに重なると、refの初期no-opへ到達する可能性がある。
  // unmount時には購読cleanupで必ず破棄し、古いstreamerの結果を新しい表示へ
  // 持ち越さない。
  const pendingDisplayResultsRef = useRef<DisplayRequest[]>([]);
  // displayResultとaddDebugLogをrefで保持することで、
  // subscriptionのuseEffectが不要に再実行されることを防ぐ
  // （soundSettings変更 → playGachaSound再生成 → displayResult再生成 のチェーンで
  //  subscriptionが破棄・再作成される問題を回避）
  const displayResultRef = useRef<DisplayResultHandler>((data) => {
    if (!isOverlayMountedRef.current) {
      return Promise.resolve(false);
    }
    return new Promise<boolean>((resolve) => {
      pendingDisplayResultsRef.current.push({ data, resolve });
    });
  });
  const addDebugLogRef = useRef<(message: string) => void>(() => {});
  const scheduleTerminalRecovery = useCallback(() => {
    if (terminalRecoveryReloadTimerRef.current) return;
    const storageKey = `${TERMINAL_RECOVERY_RELOAD_STORAGE_KEY}:${streamerId}`;
    const now = Date.now();
    let lastReloadAt = 0;
    try {
      lastReloadAt = Number(sessionStorage.getItem(storageKey) ?? 0);
    } catch {
      // A browser privacy mode can disable sessionStorage. Do not reload when
      // the cross-page budget cannot be persisted, otherwise a hard failure
      // would turn into an unbounded reload loop.
      addDebugLogRef.current('Terminal display block: reload budget unavailable');
      return;
    }
    if (Number.isFinite(lastReloadAt) && now - lastReloadAt < TERMINAL_RECOVERY_RELOAD_COOLDOWN_MS) {
      addDebugLogRef.current('Terminal display block: reload cooldown active');
      return;
    }
    try {
      sessionStorage.setItem(storageKey, String(now));
    } catch {
      addDebugLogRef.current('Terminal display block: reload budget unavailable');
      return;
    }
    addDebugLogRef.current('Terminal display block: scheduling one bounded reload');
    terminalRecoveryReloadTimerRef.current = setTimeout(() => {
      terminalRecoveryReloadTimerRef.current = null;
      if (isOverlayMountedRef.current) window.location.reload();
    }, 250);
  }, [streamerId]);
  // subscription effectはstreamerIdだけに依存させる。displayResult/addDebugLogと
  // 同じrefミラーで最新版を参照し、callback再生成による再接続を防ぐ。
  const checkOverlayVersionRef = useRef<(received: string | undefined) => void>(() => {});
  const connectionTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollCursorRef = useRef(new Date().toISOString());
  const pollHistoryIdRef = useRef("");
  const seenHistoryIdsRef = useRef<Set<string>>(new Set());
  const lastPollingErrorLogRef = useRef(0);
  // Issue #569: バージョン不一致検出＋自動リロード用のref群。
  // showCardは演出中判定にrefで参照する必要がある(setTimeoutコールバック内で
  // stateを直接読むとクロージャ生成時点の古い値のままになるため)。
  const showCardRef = useRef(showCard);
  // ジッター待機中/演出中の再試行待ち(＝リロードが予約済み)かどうか。
  // 二重にsetTimeoutを積んでしまわないようにするフラグ
  const reloadScheduledRef = useRef(false);
  // 不一致検出時に受信した「新しい」バージョン文字列。ジッター発火時・
  // 演出中の再試行時にクールダウン判定・記録で使う
  const detectedNewVersionRef = useRef<string | null>(null);
  // ジッター/再試行のsetTimeoutハンドル。アンマウント時にクリアするため保持する
  const reloadTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // attemptReloadの再帰呼び出し用ref(processQueueRefと同じパターン)。
  // useCallback内で自身の最新版を安全に参照するために使う
  const attemptReloadRef = useRef<() => void>(() => {});
  // 効果音再生用のオーディオ要素キャッシュ
  // HTMLAudioElementを使用（R2パブリックURLはCORSヘッダーがないためfetch不可、
  // audioタグはCORS不要で読み込める）
  // ルールごと（ruleId）に1つのAudio要素をプリロードして保持する。
  // 単一audioRefだとレアリティ別など複数音が設定されたとき先頭以外が
  // プリロードされず初回再生で遅延・無音になる問題を回避する。
  const audioCacheRef = useRef<Map<string, HTMLAudioElement>>(new Map());
  // ユーザー操作により音声再生がアンロック済みかどうか
  // ブラウザの自動再生ポリシーにより、最初のユーザー操作までplay()は失敗する
  const audioUnlockedRef = useRef(false);
  // SREレビュー指摘対応: 効果音の「再生終了見込み時刻」(epoch ms)。
  // attemptReloadのisMidDisplay判定(isDisplayingRef/queueRef/showCardRef)は
  // カード演出の状態しか見ておらず、displayDurationより長い効果音の再生中に
  // location.reload()が割り込むと配信画面で音が不自然に途切れる。再生開始時に
  // この時刻を記録し、時刻を過ぎるまでリロードを延期する(配信画面の音途切れ防止)。
  // ended/pauseで過去時刻(0)へ戻すため、通常は見込みより早く解除される。
  // 万一イベントが発火しなくても、時刻経過で自然に判定がfalseへ戻るため
  // リロードが恒久的に止まることはない
  const soundPlayingUntilRef = useRef(0);
  // 音声がブラウザのAutoplayポリシーでブロックされているかどうか（UI表示用）
  const [audioBlocked, setAudioBlocked] = useState(false);

  const settleDisplayCommit = useCallback((displayInstanceId: number | undefined, accepted: boolean) => {
    if (displayInstanceId === undefined) return;
    const resolve = displayCommitResolversRef.current.get(displayInstanceId);
    if (!resolve) return;
    displayCommitResolversRef.current.delete(displayInstanceId);
    const timeoutId = displayCommitTimeoutsRef.current.get(displayInstanceId);
    if (timeoutId) clearTimeout(timeoutId);
    displayCommitTimeoutsRef.current.delete(displayInstanceId);
    displayCommitEntriesRef.current.delete(displayInstanceId);
    const cleanupImageListeners = displayImageCleanupRef.current.get(displayInstanceId);
    cleanupImageListeners?.();
    displayImageCleanupRef.current.delete(displayInstanceId);
    resolve(accepted);
  }, []);

  const settleAllDisplayCommits = useCallback((accepted: boolean) => {
    const pendingIds = Array.from(displayCommitResolversRef.current.keys());
    for (const displayInstanceId of pendingIds) {
      settleDisplayCommit(displayInstanceId, accepted);
    }
    for (const timeoutId of displayCommitTimeoutsRef.current.values()) {
      clearTimeout(timeoutId);
    }
    displayCommitTimeoutsRef.current.clear();
    for (const cleanup of displayImageCleanupRef.current.values()) {
      cleanup();
    }
    displayImageCleanupRef.current.clear();
  }, [settleDisplayCommit]);

  const failDisplayBatch = useCallback((batchKey: string, reason: string) => {
    const batch = displayCommitBatchesRef.current.get(batchKey);
    if (!batch || batch.settled) return;
    batch.settled = true;
    displayCommitBatchesRef.current.delete(batchKey);
    for (const drawEventId of batch.acceptedDrawIds) {
      committedDrawIdsRef.current.add(drawEventId);
    }
    queueRef.current = queueRef.current.filter(
      (item) => item.batchKey !== batchKey,
    );
    addDebugLogRef.current(`Card batch commit failed: ${reason}`);
    const pendingIds = Array.from(batch.pendingIds);
    for (const pendingId of pendingIds) {
      settleDisplayCommit(pendingId, false);
    }
    batch.resolve(false);
  }, [settleDisplayCommit]);

  const acknowledgeDisplayItem = useCallback((
    displayInstanceId: number,
    accepted: boolean,
    drawEventId: string,
    batchKey: string,
  ) => {
    const batch = displayCommitBatchesRef.current.get(batchKey);
    if (!batch || batch.settled) return;
    batch.pendingIds.delete(displayInstanceId);
    if (!accepted) {
      failDisplayBatch(batchKey, 'item-rejected');
      return;
    }
    batch.acceptedDrawIds.add(drawEventId);
    if (batch.pendingIds.size > 0) return;
    batch.settled = true;
    displayCommitBatchesRef.current.delete(batchKey);
    for (const acceptedDrawId of batch.acceptedDrawIds) {
      committedDrawIdsRef.current.delete(acceptedDrawId);
    }
    batch.resolve(true);
  }, [failDisplayBatch]);

  const failDisplayCommit = useCallback((
    displayInstanceId: number,
    reason: string,
  ) => {
    if (!displayCommitResolversRef.current.has(displayInstanceId)) return;
    addDebugLogRef.current(`Card display commit failed: ${reason}`);
    const batchEntry = displayCommitEntriesRef.current.get(displayInstanceId);
    if (batchEntry) {
      failDisplayBatch(batchEntry.batchKey, reason);
    } else {
      settleDisplayCommit(displayInstanceId, false);
    }
    // The watchdog only releases the transport ACK. The card that is already
    // on screen must keep its normal display timer; tearing it down here would
    // turn a slow-but-visible card into a black flash and cause duplicate
    // recovery renders. If no DOM was committed, the existing display timer
    // still advances the page queue after its bounded interval.
  }, [failDisplayBatch, settleDisplayCommit]);

  const requestDisplayFallback = useCallback((displayInstanceId: number, reason: string) => {
    if (!displayCommitResolversRef.current.has(displayInstanceId)) return;
    addDebugLogRef.current(`Card image fallback requested: ${reason}`);
    // The fallback is the user-visible safety net for a missing bitmap. Force
    // this small state transition to commit before the transport callback can
    // be released; otherwise a coalesced OBS/CEF timer can observe the old
    // image-only tree and issue a false negative ACK.
    try {
      flushSync(() => setImageFallbackDisplayInstanceId(displayInstanceId));
    } catch {
      // React forbids flushSync from a lifecycle callback in some test/runtime
      // combinations. The normal state update remains safe in that case and
      // the bounded commit grace below still provides the recovery path.
      setImageFallbackDisplayInstanceId(displayInstanceId);
    }
  }, []);

  const armDisplayCommitTimeout = useCallback((displayInstanceId: number) => {
    if (
      !displayCommitResolversRef.current.has(displayInstanceId)
      || displayCommitTimeoutsRef.current.has(displayInstanceId)
    ) {
      return;
    }
    const timeoutId = setTimeout(() => {
      const committedCard = document.querySelector(
        `[data-overlay-card="true"][data-overlay-display-instance="${displayInstanceId}"]`,
      );
      if (committedCard) {
        // A slow image/paint still has a committed card. Render the explicit
        // fallback first; the commit effect acknowledges only after that DOM
        // is present, so a wrapper-only/black card cannot be reported as a
        // successful presentation.
        addDebugLogRef.current('Card display watchdog requesting fallback');
        requestDisplayFallback(displayInstanceId, 'watchdog');
        return;
      }
      failDisplayCommit(displayInstanceId, 'timeout');
    }, DISPLAY_COMMIT_ACK_TIMEOUT_MS);
    displayCommitTimeoutsRef.current.set(displayInstanceId, timeoutId);
  }, [failDisplayCommit, requestDisplayFallback]);

  useEffect(() => {
    connectionStatusRef.current = connectionStatus;
  }, [connectionStatus]);

  // Issue #569: showCardをrefにミラーする(setTimeoutコールバック内で
  // 「今演出中かどうか」を古いクロージャ値ではなく最新値で判定するため)
  useEffect(() => {
    showCardRef.current = showCard;
  }, [showCard]);

  // Issue #569: マウント時、直前のバージョン起因リロードで正確な
  // (pollCursor, pollHistoryId)/seenHistoryIdsをsessionStorageに退避していた
  // 場合はここで復元する。
  // TTL(15分)超過や壊れたJSONの場合はparsePollStateがnullを返すため、
  // その場合は何も復元されず通常どおり「今」を起点にポーリングを開始する。
  // このeffectは他のeffect(ポーリングスケジューラ・Realtime購読)より前に
  // 定義しているため、それらが最初に動く前に確実に復元が完了する。
  useEffect(() => {
    // 同じcomponent instanceでstreamer paramが変わる場合、前streamerのDB位置や
    // dedupe集合を新しい購読へ持ち込まない。
    pollCursorRef.current = new Date().toISOString();
    pollHistoryIdRef.current = "";
    seenHistoryIdsRef.current = new Set();
    try {
      const scopedKey = pollStateStorageKey(streamerId);
      // 新形式はstreamer単位。旧buildがリロード直前に書いた非scoped keyも
      // 1回だけ読み、rolling deployment中の互換性を保つ。
      const raw =
        sessionStorage.getItem(scopedKey)
        ?? sessionStorage.getItem(POLLSTATE_STORAGE_KEY);
      const restored = parsePollState(raw, Date.now(), POLLSTATE_TTL_MS);
      if (restored) {
        if (restored.pollHistoryId) {
          pollCursorRef.current = restored.pollCursor;
          pollHistoryIdRef.current = restored.pollHistoryId;
        } else {
          // 旧snapshotには同一timestamp行のtie-breakerが無い。1msだけ巻き戻し、
          // sessionStorageのseen IDで既表示分をdedupeする方が、`gt(since)`で
          // 同時刻の未表示行を永久に飛ばすより安全。
          pollCursorRef.current = new Date(
            Date.parse(restored.pollCursor) - 1,
          ).toISOString();
          pollHistoryIdRef.current = "";
        }
        seenHistoryIdsRef.current = new Set(restored.seenHistoryIds);
      }
      // 復元の成否に関わらず使用後(またはTTL切れ)は必ず削除し、残骸を残さない
      sessionStorage.removeItem(scopedKey);
      sessionStorage.removeItem(POLLSTATE_STORAGE_KEY);
    } catch {
      // OBSブラウザソース等でsessionStorageが無効/利用不可でも本体動作を壊さない
    }

    // アンマウント時、ジッター/演出中再試行待ちのタイマーが残っていればクリアする
    return () => {
      if (reloadTimeoutRef.current) {
        clearTimeout(reloadTimeoutRef.current);
      }
    };
  }, [streamerId]);

  // 効果音設定を取得し、HTMLAudioElementでプリロード
  // オーバーレイ初期化時にstreamerの効果音設定をAPIから取得
  // 認証不要のパブリックエンドポイントを使用
  useEffect(() => {
    const fetchSoundSettings = async () => {
      try {
        const response = await fetch(`/api/streamer/${streamerId}/sound-settings`);
        if (response.ok) {
          const data = await response.json();
          const soundRules = normalizeGachaSoundRules(data.soundRules);
          const soundEnabled = data.soundEnabled ?? true;
          setSoundSettings({
            soundUrl: data.soundUrl,
            soundEnabled,
            soundRules,
          });

          // Issue #638(回帰): 以前はここを `if (soundEnabled)` で丸ごと
          // ゲートしていたが、soundEnabled はレガシー互換ミラー
          // (catch-allルールの有無に連動、PR #595 F1)であり、レアリティ別・
          // 報酬別ルールしか設定していない配信ではこれが false になり得る。
          // その結果、実際には有効なルールがあるのにプリロードが一切
          // 行われず、初回再生が遅延・無音になっていた。
          // 再生され得る全URL（ルールごと + レガシー単一URL）を収集して
          // それぞれHTMLAudioElementを作成しプリロードする。
          // HTMLAudioElementはCORS不要で外部URLから読み込める（fetchとは異なる）。
          // key: ruleId、レガシーURLは固定キー "__legacy__" を使う。
          const cache = audioCacheRef.current;
          const entries: { key: string; url: string }[] = [];
          // (a) 有効なルールのURLは soundEnabled(ミラー)に関係なく常に対象にする
          for (const rule of soundRules) {
            if (rule.enabled && rule.url) {
              entries.push({ key: rule.id, url: rule.url });
            }
          }
          // (b) レガシー単一URLは、再生ロジック(resolvePlayableGachaSound)と
          // 同じ条件(ルールが空 かつ soundEnabled)の場合のみ対象にする。
          // ルールが非空ならレガシーURLは再生され得ないためプリロード不要。
          if (soundRules.length === 0 && soundEnabled && data.soundUrl) {
            entries.push({ key: "__legacy__", url: data.soundUrl });
          }

          for (const { key, url } of entries) {
            if (cache.has(key)) continue;
            const audio = new Audio(url);
            audio.preload = "auto";
            cache.set(key, audio);

            // 自動再生可能かテスト（ブロックされていればUI表示用フラグを立てる）
            audio.play().then(() => {
              // 再生成功 → 即座に停止（プリロード目的）
              audio.pause();
              audio.currentTime = 0;
              audioUnlockedRef.current = true;
            }).catch(() => {
              // NotAllowedError: 自動再生ポリシーによりブロック
              // ユーザー操作後にアンロックされる
              setAudioBlocked(true);
            });
          }
        }
      } catch (error) {
        logger.error("Failed to fetch sound settings:", error);
      }
    };
    fetchSoundSettings();
  }, [streamerId]);

  // ユーザー操作でHTMLAudioElementの再生をアンロックするハンドラー
  // ブラウザの自動再生ポリシーにより、最初のユーザー操作までplay()は失敗する
  // click/touchイベント内でplay()→pause()を呼ぶことで、以降の再生が可能になる
  // OBSブラウザソースでは「操作」ボタンから1回クリックすればOK
  useEffect(() => {
    const unlockAudio = () => {
      if (audioUnlockedRef.current) return;
      const cache = audioCacheRef.current;
      if (cache.size === 0) return;

      // ユーザー操作のコンテキスト内で全Audio要素のplay()を呼ぶことで
      // ブラウザのロックを一括解除する（複数音すべてをアンロック）。
      // Calling play() within user gesture context unlocks browser's autoplay restriction
      const audios = Array.from(cache.values());
      Promise.allSettled(
        audios.map((audio) =>
          audio.play().then(() => {
            audio.pause();
            audio.currentTime = 0;
          }),
        ),
      ).then((results) => {
        const anyUnlocked = results.some((r) => r.status === "fulfilled");
        if (anyUnlocked) {
          audioUnlockedRef.current = true;
          setAudioBlocked(false);
          logger.info("Audio unlocked after user interaction");
        }
        // 全て失敗した場合は次のクリックで再試行
      });
    };

    document.addEventListener("click", unlockAudio);
    document.addEventListener("touchstart", unlockAudio);

    return () => {
      document.removeEventListener("click", unlockAudio);
      document.removeEventListener("touchstart", unlockAudio);
    };
  }, []);

  // URLパラメータからオーバーレイオプションを解析
  // Parse overlay options from URL parameters
  // autoPortrait, smallMode, effectsはデフォルトでtrue（falseの場合のみURLパラメータで明示）
  // portraitShowRarityはデフォルトでtrue、それ以外はfalse
  // queueMicrotaskを使用してsetStateを非同期に実行し、カスケードレンダーを回避
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const isDebug = urlParams.get("debug") === "true";
    // カードの表示時間をURLパラメータから取得（デフォルト6秒、2-15秒の範囲に制限）
    // Get display duration from URL parameter (default 6 seconds, clamped to 2-15 range)
    const durationParam = urlParams.get("duration");
    const displayDuration = durationParam
      ? Math.min(15, Math.max(2, parseInt(durationParam, 10) || 6))
      : 6;
    // queueMicrotaskで非同期に実行してカスケードレンダーを回避
    queueMicrotask(() => {
      setOptions({
        imageOnly: urlParams.get("imageOnly") === "true",
        autoPortrait: urlParams.get("autoPortrait") !== "false",  // デフォルトはtrue
        effects: urlParams.get("effects") !== "false",             // デフォルトはtrue
        // レアリティ別マップ（新方式 fx=）。無ければレガシー effect=（legendary専用）→既定の順で解決。
        rarityEffectMap: parseRarityEffectMap(urlParams.get("fx"), urlParams.get("effect")),
        smallMode: urlParams.get("smallMode") !== "false",         // デフォルトはtrue
        displayDuration,  // カードの表示時間（秒）
        debug: isDebug,
        // 縦長画像の付帯情報オプション
        // pName, pRarity, pDesc, pUser（短縮パラメータ名）
        portraitShowName: urlParams.get("pName") === "true",              // デフォルトはfalse
        portraitShowRarity: urlParams.get("pRarity") !== "false",         // デフォルトはtrue
        portraitShowDescription: urlParams.get("pDesc") === "true",       // デフォルトはfalse
        portraitShowUsername: urlParams.get("pUser") === "true",          // デフォルトはfalse
      });
      if (isDebug) {
        // デバッグモードの場合、初期化ログを追加
        setDebugLogs(prev => [...prev, `[${new Date().toISOString()}] Debug mode enabled`]);
      }
    });
  }, []);

  // 画像のアスペクト比を判定（縦長かどうか）と小さい画像かどうかを判定
  // Check if image is portrait (height > width) and if image is small (< 400x400)
  // Promiseを返すが、カード表示の前提にはしない。画像metadataはpresentation-only
  // のため、呼び出し側は表示と並行して実行し、レイアウト更新だけを受け取る。
  const checkImageAspectRatio = useCallback((
    imageUrl: string | null,
    imageLayoutGeneration: number,
  ): Promise<boolean> => {
    return new Promise((resolve) => {
      if (!imageUrl) {
        if (
          isOverlayMountedRef.current
          && imageLayoutGeneration === imageLayoutGenerationRef.current
        ) {
          setIsPortraitImage(false);
          setIsSmallImage(false);
        }
        resolve(false);
        return;
      }

      const img = new window.Image();
      let settled = false;
      let timeoutId: ReturnType<typeof setTimeout> | null = null;

      // `finish` is shared by load/error/timeout so only the first terminal
      // signal can update layout state. A late load after timeout must not
      // overwrite the aspect ratio of a newer card already being displayed.
      const finish = (
        isPortrait: boolean,
        isSmall: boolean,
        updateLayout = true
      ) => {
        if (settled) return;
        settled = true;
        if (timeoutId !== null) {
          clearTimeout(timeoutId);
        }
        activeImageCheckCancelsRef.current.delete(cancel);
        if (
          updateLayout
          && isOverlayMountedRef.current
          && imageLayoutGeneration === imageLayoutGenerationRef.current
        ) {
          setIsPortraitImage(isPortrait);
          setIsSmallImage(isSmall);
        }
        resolve(isPortrait);
      };
      const cancel = () => {
        // Cleanup deliberately suppresses layout updates. Lifecycle cleanup also
        // invalidates the generation so a cancelled probe cannot affect a later
        // card or subscription.
        finish(false, false, false);
      };
      activeImageCheckCancelsRef.current.add(cancel);

      img.onload = () => {
        // 画像の縦が横より大きい（正方形でない縦長画像）の場合はポートレイト
        // Portrait if height is greater than width (not a square)
        const isPortrait = img.height > img.width;
        // 画像が400x400未満の場合は小さい画像として判定
        // 小さい画像モードを自動適用するために使用
        const isSmall = img.width < 400 && img.height < 400;
        finish(isPortrait, isSmall);
      };
      img.onerror = () => {
        finish(false, false);
      };
      timeoutId = setTimeout(() => {
        finish(false, false);
      }, IMAGE_METADATA_TIMEOUT_MS);
      img.src = imageUrl;
    });
  }, []);

  /**
   * 効果音を再生（HTMLAudioElement使用）
   * プリロード済みのAudio要素を使って再生する
   * ユーザー操作によるアンロック後であれば即座に再生される
   * 未アンロック時は再生失敗するがエラーは無視する
   */
  const playGachaSound = useCallback((data: GachaResult) => {
    // Issue #638(回帰): PR #595 F1でサーバー側ミラー(soundEnabled/soundUrl)は
    // 「有効なcatch-all(targetType==='all')ルールがある場合のみtrue/URL」を
    // 返すよう修正された。しかしここで soundEnabled を再生可否のゲートに
    // 使い続けていたため、レアリティ別・報酬別ルールしか設定していない
    // 配信では常にミラーがfalseになり、効果音が一切鳴らなくなっていた。
    // resolvePlayableGachaSound はルール対応クライアント向けに「ミラーを
    // 見ない」判定(ルール自身のenabledで再生可否を決める)を行うため、
    // これに委譲する(レガシー設定=ルール空の場合のみミラーを見る)。
    const playable = resolvePlayableGachaSound(
      {
        soundUrl: soundSettings.soundUrl,
        soundEnabled: soundSettings.soundEnabled,
        soundRules: soundSettings.soundRules,
      },
      { rarity: data.card.rarity, rewardId: data.rewardId },
    );
    if (!playable) {
      return;
    }

    try {
      // SREレビュー指摘対応: 再生開始時に「再生終了見込み時刻」をsoundPlayingUntilRefへ
      // 記録し、効果音再生中の自動リロード(attemptReload)を延期して配信画面の
      // 音途切れを防ぐ。durationはメタデータ未ロード時NaN・ライブ系でInfinityに
      // なりうるため、有限値のときだけ実尺を採用し、それ以外は安全上限へフォールバック。
      // 戻り値のクリア関数は、play()失敗(自動再生ブロック=音は鳴っていない)時に
      // 不要な延期を即解除するために使う。
      const markSoundPlaying = (audio: HTMLAudioElement) => {
        const durationMs = Number.isFinite(audio.duration)
          ? audio.duration * 1000
          : SOUND_DURATION_FALLBACK_MS;
        const until = Date.now() + durationMs;
        // 複数の音が重なった場合(前の音が鳴り終わる前に次のカードの音が始まる等)は
        // より遅い終了見込みを保持する
        soundPlayingUntilRef.current = Math.max(soundPlayingUntilRef.current, until);
        const clearGuard = () => {
          // 自分の予約が現在値のときだけ過去時刻(0)へ戻す。後続のより長い再生の
          // 予約(Math.maxで勝った値)を、先に終わった音のイベントで消さないため
          if (soundPlayingUntilRef.current === until) {
            soundPlayingUntilRef.current = 0;
          }
        };
        // 再生終了/停止時は見込み時刻を待たず即座に延期を解除する。
        // addEventListenerの蓄積ではなくプロパティ代入を使うのは、キャッシュ済み
        // Audio要素の再再生時に古いハンドラを自然に置き換えるため
        audio.onended = clearGuard;
        audio.onpause = clearGuard;
        return clearGuard;
      };

      // ルールに対応するプリロード済みAudio要素を優先的に使用する。
      // ルールが選択された場合は rule.id、レガシー単一URLの場合は固定キー
      // ("__legacy__")。いずれも resolvePlayableGachaSound の戻り値に含まれる。
      const cached = audioCacheRef.current.get(playable.cacheKey);
      if (cached && cached.src === playable.url) {
        // プリロード済みのAudio要素を使用して再生
        cached.currentTime = 0;
        const clearGuard = markSoundPlaying(cached);
        cached.play().catch(() => {
          // 自動再生ポリシーによりブロックされた場合は無視
          // ユーザーがページをクリックすればアンロックされ、次回から再生可能
          // (音は鳴っていないため、リロード延期ガードも即解除する)
          clearGuard();
        });
      } else {
        // キャッシュ未生成（取得タイミング差など）のフォールバック
        const audio = new Audio(playable.url);
        const clearGuard = markSoundPlaying(audio);
        audio.play().catch(() => {
          clearGuard();
        });
      }
    } catch (error) {
      logger.error("Error playing gacha sound:", error);
    }
  }, [soundSettings.soundEnabled, soundSettings.soundRules, soundSettings.soundUrl]);

  /**
   * キューから1件取り出して表示し、終了後に次のアイテムを処理する
   * Process one item from the queue, then recursively process the next.
   * 再帰呼び出しはprocessQueueRef経由で行い、useCallbackのクロージャが
   * 古いバージョンを参照する問題を回避する
   */
  const processQueue = useCallback(async () => {
    const queueGeneration = queueGenerationRef.current;
    const next = queueRef.current.shift();
    if (!next) {
      activeDisplayInstanceIdRef.current = undefined;
      isDisplayingRef.current = false;
      return;
    }
    activeDisplayInstanceIdRef.current = next.displayInstanceId;
    if (next.displayInstanceId !== undefined) {
      armDisplayCommitTimeout(next.displayInstanceId);
    }
    isDisplayingRef.current = true;

    // Issue #999: 以前はここから先で想定外の例外が発生すると
    // isDisplayingRef が true のまま戻らず、以後 enqueueResult() の
    // `if (!isDisplayingRef.current)` ガードが常に偽になって、後続の
    // 実イベントを受信してもキューに積まれるだけで二度と画面へ反映
    // されなくなっていた（1件でも例外が起きるとそのOBSセッションが
    // 恒久的に沈黙する）。
    //
    // レビュー指摘#1対応: 単純に外側をtry/catchで囲むだけでは不十分
    // だった。下の3段のsetTimeoutコールバック（表示後の音声再生・次
    // カードへの再帰呼び出しを含む）は、それをスケジュールした関数の
    // try/catchの動的スコープに含まれない別タスクとして実行される
    // ため、その中で投げた例外は外側のcatchに伝播せず、同じロック
    // 固着バグが再現してしまう。runProtectedで各コールバック本体を
    // 個別に保護し、どの区間で例外が起きても同じ経路（handleQueueError）
    // でロックを解放できるようにする。
    //
    // レビュー指摘#2対応: catch側の再継続を同期的な直接呼び出しに
    // すると、同一の例外がキュー内の全アイテムで連続して起きた場合に
    // 同期呼び出しの連鎖でコールスタックを消費し続け、RangeError
    // (Maximum call stack size exceeded)で落ちてロックが解放されない
    // まま終わりうる（実測で約8000件連続でスタックオーバーフローを
    // 確認済み）。setTimeout(..., 0)でマクロタスクへ逃がし、各
    // イテレーションで確実にコールスタックを巻き戻す。
    const handleQueueError = (error: unknown) => {
      logger.error("Error processing gacha display queue:", error);
      addDebugLogRef.current(
        `processQueue error: ${error instanceof Error ? error.message : String(error)}`
      );
      // If this item never committed, tell the transport to retry it instead
      // of permanently deduplicating a draw that the viewer could not see.
      settleDisplayCommit(next.displayInstanceId, false);
      // ロックを握ったまま関数を抜けないよう、失敗したカードは諦めて
      // 残りのキューを継続する。キューが尽きていれば冒頭の `if (!next)`
      // 分岐でロックが解放される。
      setTimeout(() => processQueueRef.current(), 0);
    };
    const runProtected = (fn: () => void) => {
      try {
        fn();
      } catch (error) {
        handleQueueError(error);
      }
    };

    try {
      // Issue #1076: the exact OBS/CEF root cause is still unconfirmed. The real
      // preview path received a valid gacha payload but produced no card DOM/
      // pixels. Image metadata is presentation-only, so a business event must not
      // depend on this preflight before mounting its DOM. Decouple the probe as a
      // defensive fix; the existing 1.5s probe timeout would normally bound the
      // old wait, so preview real-path validation remains mandatory after merge.
      const imageLayoutGeneration = imageLayoutGenerationRef.current + 1;
      imageLayoutGenerationRef.current = imageLayoutGeneration;
      if (
        !isOverlayMountedRef.current
        || queueGeneration !== queueGenerationRef.current
      ) {
        // The item was dequeued immediately before transport cleanup or an
        // unmount. Release the display lock so a later subscription can render.
        addDebugLogRef.current('Card display aborted: inactive subscription');
        settleDisplayCommit(next.displayInstanceId, false);
        activeDisplayInstanceIdRef.current = undefined;
        isDisplayingRef.current = false;
        return;
      }
      setIsPortraitImage(false);
      setIsSmallImage(false);
      setImageFallbackDisplayInstanceId(null);
      // The realtime contract deliberately carries only the public card
      // fields. Snapshot the fields consumed by this component before the
      // state update so a malformed object/getter cannot make React fail while
      // rendering the card branch and leave the overlay black.
      const displayCard = {
        id: next.card.id,
        name: next.card.name,
        description: next.card.description,
        image_url: next.card.image_url,
        image_padding_color: next.card.image_padding_color,
        rarity: next.card.rarity,
      } as Card;
      const displayResult = { ...next, card: displayCard };
      // `result`を先に確定する。エフェクト設定はpresentation-onlyなので、
      // 解決に失敗してもbusiness eventのカードDOMを失わせない。
      setResult(displayResult);
      // カード表示をmetadataやタイマーの完了条件にしない。OBS/CEFや
      // バックグラウンドのブラウザではsetTimeoutが遅延することがあり、
      // revealを待つだけでも実交換後の有効窓を全面黒画面にしてしまう。
      // business eventを受信した時点でカードを可視化し、metadataは
      // presentation-onlyのレイアウト更新として並行して扱う。
      setShowCard(true);
      // The state setter has run, but the DOM commit happens on the next React
      // render. Use "scheduled" here; the commit effect below is the only place
      // that reports an actual card DOM commit.
      addDebugLogRef.current('Card display scheduled');

      // Start the presentation-only metadata probe *after* scheduling the card
      // state. Even a future Image implementation that throws before returning
      // a Promise cannot move the business event back behind this probe.
      const imageMetadataPromise = checkImageAspectRatio(
        displayCard.image_url,
        imageLayoutGeneration,
      ).catch((error) => {
        // Metadata is optional presentation data; a probe failure must not drop
        // or advance the business-event queue after the card has started.
        logger.warn("Overlay image metadata probe failed:", error);
        addDebugLogRef.current(
          `image metadata probe failed: ${error instanceof Error ? error.message : String(error)}`
        );
      });

      try {
        // このカードのレアリティに紐づくエフェクトを解決する。
        // effects スイッチが OFF なら常に "none"（全レアリティ無効）。
        const resolvedStyle = options.effects
          ? resolveEffectForRarity(options.rarityEffectMap, displayCard.rarity)
          : "none";
        setActiveEffectStyle(resolvedStyle);
        setEffectParticles(generateOverlayEffectParticles(resolvedStyle));
      } catch (error) {
        logger.warn("Overlay effect setup failed; using no effect:", error);
        addDebugLogRef.current(
          `effect setup failed: ${error instanceof Error ? error.message : String(error)}`
        );
        setActiveEffectStyle("none");
        setEffectParticles([]);
      }

      // 表示は既に開始済み。ここでは効果音と表示終了だけを予約する。
      // metadataの解決やrevealタイマーをカードDOMのliveness条件にしない。
      animationTimeoutRef.current = setTimeout(() => runProtected(() => {
        if (
          !isOverlayMountedRef.current
          || queueGeneration !== queueGenerationRef.current
        ) {
          // Lifecycle cleanup owns the display-lock reset. An obsolete
          // chain must never unlock a newer subscription's active queue.
          return;
        }
        if (next.shouldPlaySound !== false) {
          if (next.soundGroupId) {
            if (!playedSoundGroupIdsRef.current.has(next.soundGroupId)) {
              playedSoundGroupIdsRef.current.add(next.soundGroupId);
              playGachaSound(displayResult);
            }
          } else {
            playGachaSound(displayResult);
          }
        }

        // Hide after display, then process next queued item.  If the image is
        // still pending when the display window expires, first render the
        // explicit fallback card and settle its transport promise.  This is
        // important for short displayDuration values: hiding the only card
        // before the 4.5s watchdog would otherwise turn a slow image into a
        // false failure and an endlessly retried, black overlay.
        const hideAndAdvance = () => {
          setShowCard(false);
          animationTimeoutRef.current = setTimeout(() => runProtected(() => {
            // Once the outgoing card is removed, its callbacks must not affect
            // the next card even if the browser retained the Image object.
            imageLayoutGenerationRef.current += 1;
            activeDisplayInstanceIdRef.current = undefined;
            setResult(null);
            setImageFallbackDisplayInstanceId(null);
            // ref経由で最新のprocessQueueを呼び出し（再帰）
            processQueueRef.current();
          }), 500);
        };
        const hideAfterFallbackVisible = () => {
          const expectedQueueGeneration = queueGeneration;
          const displayInstanceId = next.displayInstanceId;
          fallbackVisibilityTimeoutRef.current = setTimeout(
            () => runProtected(() => {
              fallbackVisibilityTimeoutRef.current = null;
              if (
                !isOverlayMountedRef.current
                || queueGenerationRef.current !== expectedQueueGeneration
                || activeDisplayInstanceIdRef.current !== displayInstanceId
              ) {
                return;
              }
              hideAndAdvance();
            }),
            DISPLAY_FALLBACK_MIN_VISIBLE_MS,
          );
        };
        const finishDisplayWindow = () => {
          const displayInstanceId = next.displayInstanceId;
          if (
            displayInstanceId === undefined
            || !displayCommitResolversRef.current.has(displayInstanceId)
          ) {
            hideAndAdvance();
            return;
          }
          requestDisplayFallback(displayInstanceId, 'display-window-expired');
          const settleFallbackAfterCommit = (elapsedMs: number) => {
            if (!isOverlayMountedRef.current || queueGeneration !== queueGenerationRef.current) {
              return;
            }
            if (!displayCommitResolversRef.current.has(displayInstanceId)) {
              // The fallback commit effect already acknowledged the card.
              hideAfterFallbackVisible();
              return;
            }
            const cardRoot = document.querySelector(
              `[data-overlay-card="true"][data-overlay-display-instance="${displayInstanceId}"]`,
            );
            const fallbackRoot = cardRoot?.querySelector('[data-overlay-card-fallback="true"]');
            if (fallbackRoot) {
              settleDisplayCommit(displayInstanceId, true);
              hideAfterFallbackVisible();
              return;
            }
            if (elapsedMs < DISPLAY_FALLBACK_COMMIT_GRACE_MS) {
              setTimeout(
                () => runProtected(() => settleFallbackAfterCommit(elapsedMs + DISPLAY_FALLBACK_COMMIT_RETRY_MS)),
                DISPLAY_FALLBACK_COMMIT_RETRY_MS,
              );
              return;
            }
            failDisplayCommit(displayInstanceId, 'fallback-not-committed');
            hideAndAdvance();
          };
          setTimeout(() => runProtected(() => settleFallbackAfterCommit(0)), 0);
        };
        animationTimeoutRef.current = setTimeout(() => runProtected(() => {
          finishDisplayWindow();
        }), options.displayDuration * 1000);
      }), MIN_REVEAL_LEAD_IN_MS);
      void imageMetadataPromise
        .catch(handleQueueError);
    } catch (error) {
      handleQueueError(error);
    }
  }, [armDisplayCommitTimeout, checkImageAspectRatio, failDisplayCommit, playGachaSound, options.displayDuration, options.effects, options.rarityEffectMap, requestDisplayFallback, settleDisplayCommit]);

  // processQueueRefを最新のcallbackで更新
  useEffect(() => {
    processQueueRef.current = processQueue;
  }, [processQueue]);

  /**
   * 新しいガチャ結果をキューに追加し、未再生なら再生を開始する
   * Enqueue a new gacha result; start playback if idle
   */
  const enqueueResult = useCallback((data: GachaResult): Promise<boolean> => {
    // Ignore callbacks from an old transport instance after streamer switch or
    // unmount. Without this guard a late polling/WS callback could repopulate
    // the queue after cleanup and make the next subscription display stale data.
    if (!isOverlayMountedRef.current) {
      addDebugLogRef.current('Ignored display callback: inactive subscription');
      return Promise.resolve(false);
    }
    const cards = data.cards?.length ? data.cards : [data.card];
    const drawEventIds = data.drawEventIds?.length === cards.length
      ? data.drawEventIds
      : undefined;
    if (
      drawEventIds
      && Array.from({ length: drawEventIds.length }, (_, index) => drawEventIds[index]).some((drawEventId) => (
        typeof drawEventId !== 'string' || drawEventId.length === 0
      ))
    ) {
      addDebugLogRef.current('Ignored batch with missing draw identity');
      return Promise.resolve(false);
    }
    const batchKey = drawEventIds?.[0]
      ?? `overlay-batch-${displayInstanceSequenceRef.current + 1}`;
    const pendingCards = cards
      .map((card, index) => ({
        card,
        index,
        drawEventId: drawEventIds?.[index],
      }))
      .filter(({ drawEventId }) => (
        !drawEventId || !committedDrawIdsRef.current.has(drawEventId)
      ));
    if (pendingCards.length === 0) {
      return Promise.resolve(true);
    }
    // PR #451 レビュー指摘(F2): 「1枚目のカード」固定ではなく、バッチ全体から
    // ルール一致優先度(reward > rarity > all、同率ならより希少なレアリティ)が
    // 最も高い1枚を選んで、そのカードの表示タイミングでのみ音を鳴らす。
    // 上位から明示的に shouldPlaySound: false が来ている場合はバッチ全体を
    // 無音にする(現状これを設定する呼び出し元は無いが、既存の安全弁として維持)。
    const soundBearingIndex = data.shouldPlaySound === false
      ? -1
      : pickSoundBearingCardIndex(cards, data.rewardId, soundSettings.soundRules);
    const displayItems = pendingCards.map(({ card, index, drawEventId }) => ({
        ...data,
        card,
        cards: undefined,
        drawEventId,
        batchKey: drawEventIds ? batchKey : undefined,
        shouldPlaySound: index === soundBearingIndex,
        displayInstanceId: ++displayInstanceSequenceRef.current,
      }));
    const firstDisplayInstanceId = displayItems[0]?.displayInstanceId;
    if (firstDisplayInstanceId === undefined) {
      return Promise.resolve(false);
    }
    const commitPromise = new Promise<boolean>((resolve) => {
      if (drawEventIds) {
        const batch: DisplayCommitBatch = {
          batchKey,
          pendingIds: new Set(displayItems.map((item) => item.displayInstanceId)),
          acceptedDrawIds: new Set(),
          resolve,
          settled: false,
        };
        displayCommitBatchesRef.current.set(batchKey, batch);
        for (const item of displayItems) {
          const displayInstanceId = item.displayInstanceId;
          const drawEventId = item.drawEventId;
          if (drawEventId === undefined) {
            // A malformed batch must fail closed rather than leaving its
            // Promise pending forever and blocking the transport queue.
            failDisplayBatch(batchKey, 'missing-draw-id');
            return;
          }
          displayCommitEntriesRef.current.set(displayInstanceId, {
            batchKey,
            drawEventId,
          });
          displayCommitResolversRef.current.set(displayInstanceId, (accepted) => {
            acknowledgeDisplayItem(
              displayInstanceId,
              accepted,
              drawEventId,
              batchKey,
            );
          });
        }
        return;
      }

      displayCommitResolversRef.current.set(firstDisplayInstanceId, resolve);
    });
    queueRef.current.push(...displayItems);
    if (!isDisplayingRef.current) {
      // Realtime callbacks outlive a particular render. Resolve through the
      // ref so a sound/options update cannot leave the queue using an obsolete
      // processQueue closure (or bypass the lifecycle generation guard).
      processQueueRef.current();
    }
    return commitPromise;
  }, [acknowledgeDisplayItem, failDisplayBatch, soundSettings.soundRules]);

  // refを最新のcallbackで更新（useEffectの依存配列に含めずに最新の関数を参照するため）。
  // 購読開始前に届いたpayloadがあれば、ここで最新のenqueueへ一度だけ渡す。
  // これにより「受信ログは残るがdisplayResultRefの初期no-opでカードが
  // 消える」競合を、追加のchannel-point消費なしで防ぐ。
  useEffect(() => {
    const pendingDisplayResults = pendingDisplayResultsRef.current;
    displayResultRef.current = enqueueResult;
    const pending = pendingDisplayResults.splice(0);
    for (const data of pending) {
      void enqueueResult(data.data).then(data.resolve);
    }
    return () => {
      // dependency更新中は次のeffectがすぐにhandlerを再登録する。再登録まで
      // に届いたpayloadは同じバッファへ退避し、subscription cleanup側だけが
      // streamer切替/unmount時にバッファを破棄する。
      displayResultRef.current = (data) => {
        if (!isOverlayMountedRef.current) {
          return Promise.resolve(false);
        }
        return new Promise<boolean>((resolve) => {
          pendingDisplayResults.push({ data, resolve });
        });
      };
    };
  }, [enqueueResult]);

  /**
   * Issue #569: バージョン不一致検出後、ジッター待機を経て実際にリロードするか
   * どうかを判定・実行する。ジッター発火時と「演出中につき延期」からの再試行時の
   * 両方からこの同じ関数が呼ばれる(再帰)。
   *
   * 自身の再帰呼び出しは attemptReloadRef 経由で行う(processQueueRef と同じ
   * パターン)。useCallback内で定義中の変数を直接自己参照すると、ESLintの
   * React Compiler向けルール(react-hooks/immutability)が
   * 「宣言前アクセス」として検出するため、既存コードと同じ ref 間接参照に揃える。
   */
  const attemptReload = useCallback(() => {
    // 演出中(キュー処理中・キュー待ち・カード表示中)は演出を壊さないよう
    // 30秒後に同じ判定をやり直す(設計上の要件3番)。
    // SREレビュー指摘対応: displayDurationより長い効果音がまだ鳴っている間の
    // リロードは配信画面の音を不自然に途切れさせるため、効果音の再生終了見込み
    // 時刻(soundPlayingUntilRef、playGachaSound参照)も延期条件に含める
    const isMidDisplay =
      isDisplayingRef.current ||
      queueRef.current.length > 0 ||
      showCardRef.current ||
      Date.now() < soundPlayingUntilRef.current;
    if (isMidDisplay) {
      addDebugLogRef.current("[version] reload deferred: display in progress");
      reloadTimeoutRef.current = setTimeout(() => {
        attemptReloadRef.current();
      }, RELOAD_DEFER_RETRY_MS);
      return;
    }

    // スケジュール時に必ず設定されるため通常は非nullだが、型上の防御として確認する
    const targetVersion = detectedNewVersionRef.current;
    if (!targetVersion) {
      reloadScheduledRef.current = false;
      return;
    }

    // 実行直前にクールダウン判定(sessionStorageアクセスはOBS等で無効な場合に
    // 備えtry/catchで包む。読み取り失敗時はクールダウン無しとして扱う。
    // JSONの形状検証はparseReloadCooldownRecords(overlay-version.ts)に委譲し、
    // parsePollStateと同じ「壊れたデータでも例外を投げずnullを返す」方針に揃える)
    // Issue #634: 単一の直前記録ではなく直近見た複数バージョンの配列を保持し、
    // ローリングデプロイ中のバージョン往復(A→B→A→B)でもクールダウンが機能する
    // ようにする(詳細はoverlay-version.tsのMAX_RELOAD_COOLDOWN_RECORDS doc参照)。
    let cooldownRecords: ReturnType<typeof parseReloadCooldownRecords> = null;
    try {
      cooldownRecords = parseReloadCooldownRecords(sessionStorage.getItem(RELOAD_COOLDOWN_STORAGE_KEY));
    } catch {
      cooldownRecords = null;
    }

    if (isReloadCooldownActive(cooldownRecords, targetVersion, Date.now(), RELOAD_COOLDOWN_MS)) {
      addDebugLogRef.current(`[version] reload skipped: cooldown active for ${targetVersion}`);
      // クールダウン明け後にもう一度チャンスを与えるため予約フラグを解除する。
      // 次のポーリング/バージョン確認サイクルで不一致が再検出されれば再スケジュールされる。
      reloadScheduledRef.current = false;
      return;
    }

    // クールダウン記録と、リロード後に復元するポーリング状態をsessionStorageへ退避する。
    // 退避に失敗してもリロード自体は続行する(取りこぼし防止より前進を優先)
    try {
      sessionStorage.setItem(
        RELOAD_COOLDOWN_STORAGE_KEY,
        JSON.stringify(upsertReloadCooldownRecord(cooldownRecords, targetVersion, Date.now())),
      );
      sessionStorage.setItem(
        pollStateStorageKey(streamerId),
        serializePollState({
          pollCursor: pollCursorRef.current,
          pollHistoryId: pollHistoryIdRef.current,
          seenHistoryIds: Array.from(seenHistoryIdsRef.current),
          savedAt: Date.now(),
        }),
      );
    } catch {
      // OBSブラウザソース等でsessionStorageが無効/利用不可でも本体動作を壊さない
    }

    addDebugLogRef.current(`[version] reloading to ${targetVersion}`);
    // リロード窓での演出取りこぼしを防ぐため、演出中でなくクールダウンもクリアな
    // 「今」のタイミングで遅延せず即座にリロードする
    location.reload();
  }, [streamerId]);

  // attemptReloadRefを最新のcallbackで更新(processQueueRefと同じパターン)
  useEffect(() => {
    attemptReloadRef.current = attemptReload;
  }, [attemptReload]);

  /**
   * Issue #569: transport controllerのconfig/events応答に含まれるoverlayVersionを
   * 自身のビルドバージョンと比較し、不一致ならリロードをスケジュールする。
   */
  const checkOverlayVersion = useCallback((received: string | undefined) => {
    if (!shouldScheduleReload(CURRENT_OVERLAY_VERSION, received)) {
      return;
    }
    if (reloadScheduledRef.current) {
      // 既にジッター待機/演出中の再試行待ちの場合は再スケジュールしない(設計2番)
      return;
    }
    reloadScheduledRef.current = true;
    detectedNewVersionRef.current = received as string;
    addDebugLogRef.current(`[version] mismatch detected: ${CURRENT_OVERLAY_VERSION} -> ${received}`);

    // サンダリングハード回避: 全クライアントが同時に新バージョンを検知しても
    // 一斉リロード→同時アクセス集中が起きないよう、0〜RELOAD_JITTER_MAX_MSでランダムに散らす
    const jitterMs = Math.floor(Math.random() * RELOAD_JITTER_MAX_MS);
    reloadTimeoutRef.current = setTimeout(() => {
      attemptReload();
    }, jitterMs);
  }, [attemptReload]);

  // transport callbackから常に最新版を呼びつつ、subscription useEffectの
  // dependencyへcheckOverlayVersionを追加して再購読を誘発しない。
  useEffect(() => {
    checkOverlayVersionRef.current = checkOverlayVersion;
  }, [checkOverlayVersion]);

  /**
   * 旧transportから残すdisconnected時限定の緊急polling loop。
   *
   * 現在のtransport controllerはsubscribeToGachaResults内でDOをprimaryとし、
   * PlanetScale履歴をgap recoveryとして読む。controllerがconnectedを報告して
   * いる間はnetwork前にreturnし、version通知もcontrollerのconfig/events応答から
   * 受け取るため、この旧loopはWorker invocationもDB queryも発生させない。
   */
  const pollOverlayEvents = useCallback(async (isActive: () => boolean = () => true) => {
    if (
      connectionStatusRef.current === "connected"
      || legacyPollingSuppressedRef.current
    ) {
      return;
    }

    const buildEventsUrl = () => {
      const url = new URL(`/api/overlay/${streamerId}/events`, window.location.origin);
      url.searchParams.set("since", pollCursorRef.current);
      if (pollHistoryIdRef.current) {
        url.searchParams.set("afterId", pollHistoryIdRef.current);
      }
      url.searchParams.set("_", String(Date.now()));
      return url.toString();
    };

    try {
      const data = await fetchJsonWithXhrFallback<{
        events?: OverlayPollingEvent[];
        nextCursor?: OverlayHistoryCursor | null;
        overlayVersion?: string;
      }>(buildEventsUrl());
      if (!isActive()) return;
      checkOverlayVersion(data.overlayVersion);
      const events = data.events ?? [];
      for (const event of events) {
        if (!isActive()) return;
        if (seenHistoryIdsRef.current.has(event.id)) {
          continue;
        }
        addDebugLogRef.current(`Polling fallback received: ${event.id}`);
        const accepted = await displayResultRef.current({
          card: event.card as Card,
          userTwitchUsername: event.userTwitchUsername,
          historyId: event.id,
          soundGroupId: event.eventId?.replace(/:\d+$/, "") ?? event.id,
          rewardId: event.rewardId ?? null,
        });
        if (!isActive() || !accepted) {
          throw new Error('overlay callback rejected fallback event');
        }
        seenHistoryIdsRef.current.add(event.id);
        pollCursorRef.current = event.redeemedAt;
        pollHistoryIdRef.current = event.id;
      }
      // The server cursor also advances across defensive LEFT JOIN misses that
      // produce no display event. Prefer it over the last rendered row so a
      // malformed historical card cannot pin recovery on the same DB page.
      if (
        data.nextCursor
        && isValidOverlayHistoryId(data.nextCursor.historyId)
      ) {
        const normalizedCursor = normalizeOverlayHistoryTimestamp(
          data.nextCursor.redeemedAt,
        );
        if (normalizedCursor) {
          pollCursorRef.current = normalizedCursor;
          pollHistoryIdRef.current = data.nextCursor.historyId;
        }
      }
    } catch (error) {
      const now = Date.now();
      if (now - lastPollingErrorLogRef.current > 30000) {
        lastPollingErrorLogRef.current = now;
        logger.warn("Overlay polling fallback error:", error);
        addDebugLogRef.current("Polling fallback network error; retrying");
      }
    }
  }, [streamerId, checkOverlayVersion]);

  useEffect(() => {
    let stopped = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const schedule = () => {
      timeoutId = setTimeout(async () => {
        await pollOverlayEvents(() => !stopped);
        if (!stopped) {
          schedule();
        }
      }, 3000);
    };

    schedule();

    return () => {
      stopped = true;
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    };
  }, [pollOverlayEvents]);

  // デバッグログを追加するヘルパー関数
  // OBSブラウザソースでの接続問題を調査するために使用
  const addDebugLog = useCallback((message: string) => {
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] ${message}`;
    logger.info(logEntry);
    setDebugLogs(prev => [...prev.slice(-19), logEntry]); // 最新20件を保持
  }, []);

  // refを最新のcallbackで更新
  useEffect(() => {
    addDebugLogRef.current = addDebugLog;
  }, [addDebugLog]);

  // `setResult` only schedules a React update; it does not prove that the
  // card branch has committed to the DOM. Keep a separate commit marker so the
  // fixed-overlay investigation can distinguish an event that never reached
  // the queue from a React/browser paint problem. This is intentionally free
  // of card names, IDs, URLs, and user data.
  useLayoutEffect(() => {
    if (!result) return;
    const displayInstanceId = result.displayInstanceId;
    if (displayInstanceId === undefined) return;
    if (!displayCommitResolversRef.current.has(displayInstanceId)) return;
    addDebugLogRef.current('Card display committed');
    const previousImageCleanup = displayImageCleanupRef.current.get(displayInstanceId);
    previousImageCleanup?.();
    displayImageCleanupRef.current.delete(displayInstanceId);
    const cardRoot = document.querySelector(
      `[data-overlay-card="true"][data-overlay-display-instance="${displayInstanceId}"]`,
    );
    if (!cardRoot) {
      // The bounded watchdog owns this failure path. A transient React commit
      // gap must not be acknowledged as a duplicate, but resolving false here
      // would race a same-turn commit and create an unnecessary replay.
      addDebugLogRef.current('Card display commit missing DOM');
      return;
    }

    const fallbackRoot = cardRoot.querySelector('[data-overlay-card-fallback="true"]');
    if (imageFallbackDisplayInstanceId === displayInstanceId && fallbackRoot) {
      // Keep the real <img> mounted while the painted fallback is visible.
      // A slow image may still finish loading after the watchdog; removing it
      // here would make the fallback permanent and turn a delayed but valid
      // card into a regression.
      addDebugLogRef.current('Card image fallback committed');
      settleDisplayCommit(displayInstanceId, true);
    }

    if (!result.card.image_url) {
      if (fallbackRoot) {
        settleDisplayCommit(displayInstanceId, true);
      }
      return;
    }

    const image = cardRoot.querySelector('img') as HTMLImageElement | null;
    if (!image) {
      addDebugLogRef.current('Card display commit missing image');
      return;
    }

    const imageIsReady = (
      image.complete
      && image.naturalWidth > 0
      && image.naturalHeight > 0
    );
    if (imageIsReady) {
      if (imageFallbackDisplayInstanceId === displayInstanceId) {
        setImageFallbackDisplayInstanceId(current => (
          current === displayInstanceId ? null : current
        ));
      }
      settleDisplayCommit(displayInstanceId, true);
      return;
    }

    addDebugLogRef.current('Card image awaiting load');
    const onLoad = () => {
      if (image.complete && image.naturalWidth > 0 && image.naturalHeight > 0) {
        if (imageFallbackDisplayInstanceId === displayInstanceId) {
          setImageFallbackDisplayInstanceId(current => (
            current === displayInstanceId ? null : current
          ));
        }
        settleDisplayCommit(displayInstanceId, true);
      } else {
        addDebugLogRef.current('Card image load completed without dimensions');
        requestDisplayFallback(displayInstanceId, 'image-invalid');
      }
    };
    const onError = () => {
      // A permanent 404/CORS/R2 failure must not be retried forever, but it is
      // not a successful presentation until the visible fallback DOM commits.
      addDebugLogRef.current('Card image failed; requesting visible fallback');
      requestDisplayFallback(displayInstanceId, 'image-error');
    };
    const cleanup = () => {
      image.removeEventListener('load', onLoad);
      image.removeEventListener('error', onError);
      if (displayImageCleanupRef.current.get(displayInstanceId) === cleanup) {
        displayImageCleanupRef.current.delete(displayInstanceId);
      }
    };
    image.addEventListener('load', onLoad, { once: true });
    image.addEventListener('error', onError, { once: true });
    displayImageCleanupRef.current.set(displayInstanceId, cleanup);
    return cleanup;
  }, [imageFallbackDisplayInstanceId, isPortraitImage, requestDisplayFallback, result, settleDisplayCommit]);

  // #694 Stage 6b: maintenance状態のポーリング（debugパネル表示専用）。
  //
  // options.debug のときだけポーリングする設計にした理由:
  // overlayページはOBSブラウザソースとして配信中ずっと（時に何時間も、
  // 配信者の数だけ同時に）開かれ続ける常設ページであり、通常の配信画面
  // 表示自体はmaintenance状態を一切必要としない（issueの要求「通常表示は
  // 継続」）。debug=trueは開発者が手動で接続調査するときにだけ付けるURL
  // パラメータなので、ここでポーリングを条件付けることで「調査時以外は
  // maintenance-status APIへのアクセスが一切発生しない」設計にできる。
  // これによりオーバーレイ経由の追加サーバー負荷を実質ゼロに保てる
  // （ダッシュボード側のMaintenanceStatusProviderが常時60秒間隔で叩くのとは
  // 対照的に、overlay側は「開発者がdebug表示を開いている間だけ」に限定する）。
  //
  // ポーリング間隔は60秒（ダッシュボード側と同じ値）。デバッグ目的なので
  // 秒単位の即時性は不要だが、調査セッション中に切替があった場合は
  // 1分以内にdebugパネルへ反映される。
  useEffect(() => {
    if (!options.debug) {
      return;
    }

    let cancelled = false;
    // 直近取得したmodeをローカル変数で保持し、実際に変化した回だけdebugLogへ
    // 追記する。前回値との比較をsetState更新関数の中で行うとReact Compilerが
    // 要求するpurityルールに抵触する（このファイル冒頭の他のuseRefコメント
    // 参照）ため、比較はここ＝effectコールバック側で行う。
    let previousMode: MaintenanceMode = maintenanceMode;

    const checkMaintenanceStatus = async () => {
      const status = await fetchMaintenanceStatus();
      if (cancelled) return;
      if (status.mode !== previousMode) {
        addDebugLogRef.current(`[maintenance] mode: ${previousMode} -> ${status.mode}`);
        previousMode = status.mode;
      }
      setMaintenanceMode(status.mode);
    };

    checkMaintenanceStatus();
    const intervalId = setInterval(checkMaintenanceStatus, 60_000);

    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
    // maintenanceModeは上のpreviousMode初期化にしか使わず、以後はローカル
    // 変数previousModeで追跡する。依存配列に含めるとmode変化のたびにこの
    // effect自体が再実行され、intervalが不要に張り直されてしまうため、
    // 意図的に省略する。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options.debug]);

  // Start the runtime-configured DO primary with PlanetScale gap recovery.
  // 依存配列は streamerId のみ。displayResult/addDebugLog は ref 経由で参照し、
  // callback の再生成（soundSettings 変更等）で subscription が破棄・再作成されないようにする
  useEffect(() => {
    const subscriptionGeneration = ++subscriptionGenerationRef.current;
    isOverlayMountedRef.current = true;
    legacyPollingSuppressedRef.current = false;
    const playedSoundGroupIds = playedSoundGroupIdsRef.current;
    const activeImageCheckCancels = activeImageCheckCancelsRef.current;
    const pendingDisplayResults = pendingDisplayResultsRef.current;
    const displayCommitBatches = displayCommitBatchesRef.current;
    const displayCommitEntries = displayCommitEntriesRef.current;
    const committedDrawIds = committedDrawIdsRef.current;

    queueMicrotask(() => {
      addDebugLogRef.current(`Starting subscription for streamer: ${streamerId}`);
      addDebugLogRef.current(
        'Transport controller: Durable Objects primary + PlanetScale recovery'
      );
    });

    const cleanup = subscribeToGachaResults(streamerId, (payload) => {
      addDebugLogRef.current(`Received payload: ${payload.type}`);
      if (
        !isOverlayMountedRef.current
        || subscriptionGenerationRef.current !== subscriptionGeneration
      ) {
        addDebugLogRef.current('Ignored payload after subscription cleanup');
        return false;
      }
      if (payload.type === 'gacha' && payload.card) {
        return displayResultRef.current({
          card: payload.card as unknown as Card,
          cards: payload.cards as unknown as Card[] | undefined,
          userTwitchUsername: payload.userTwitchUsername,
          rewardId: payload.rewardId ?? null,
          drawEventIds: payload.drawEventIds,
          // A reconnect recovery page can contain only part of a very large
          // backlog. Preserve the versioned batch key so later pages do not
          // replay the same N-draw sound even though their cards still render.
          soundGroupId: payload.soundGroupId,
        });
      } else if (payload.type === 'gacha') {
        // Issue #999: 「Received payload: gacha」のログだけでは、payload に
        // card が欠落していて表示ゲートを通らなかったケースと、実際に表示
        // まで進んだケースを区別できない（無音の分岐だった）。実引き換えで
        // カードが表示されない不具合の一次切り分けを実機ログだけで行える
        // ようにするため、card 欠落時だけ明示的に記録する。cards（N連の
        // 残り）の件数も併記し、「card だけ欠けている」のか「両方欠けて
        // いる」のかを実機ログから区別できるようにする（レビュー指摘）。
        addDebugLogRef.current(
          `Gacha payload missing card (rewardId=${payload.rewardId ?? 'null'}, `
          + `cardsCount=${payload.cards?.length ?? 0})`
        );
      }
      return true;
    }, {
      // Cursor ownership stays inside the transport controller. The page only
      // mirrors its exact DB pair so a build-version reload can hand the same
      // position to the next controller instance without a time-only gap.
      initialHistoryCursor: {
        redeemedAt: pollCursorRef.current,
        historyId: pollHistoryIdRef.current,
      },
      onHistoryCursor: (cursor) => {
        pollCursorRef.current = cursor.redeemedAt;
        pollHistoryIdRef.current = cursor.historyId;
      },
      onError: (error) => {
        addDebugLogRef.current(`Connection error: ${error.message} (expected: ${error.isExpected})`);
        if (error.message === 'Overlay card delivery blocked after retry limit') {
          legacyPollingSuppressedRef.current = true;
          scheduleTerminalRecovery();
        }
        if (error.isExpected) {
          setConnectionStatus('disconnected');
          setErrorMessage(null);
        } else {
          setConnectionStatus('error');
          setErrorMessage(error.message);
        }
      },
      onSuccess: () => {
        addDebugLogRef.current('Connection successful - SUBSCRIBED');
        legacyPollingSuppressedRef.current = false;
        setConnectionStatus('connected');
        if (connectionTimeoutRef.current) {
          clearTimeout(connectionTimeoutRef.current);
          connectionTimeoutRef.current = null;
        }
      },
      onStatusChange: (status) => {
        addDebugLogRef.current(`Connection status: ${status}`);
      },
      onOverlayVersion: (overlayVersion) => {
        checkOverlayVersionRef.current(overlayVersion);
      },
    });

    connectionTimeoutRef.current = setTimeout(() => {
      if (connectionStatusRef.current === 'connecting') {
        addDebugLogRef.current('Connection timeout after 30 seconds');
        setConnectionStatus('error');
        setErrorMessage('Connection timeout - OBSの場合はブラウザソースを再作成してください');
      }
    }, 30000);

    cleanupRef.current = cleanup;

    return () => {
      if (subscriptionGenerationRef.current === subscriptionGeneration) {
        subscriptionGenerationRef.current += 1;
      }
      isOverlayMountedRef.current = false;
      queueGenerationRef.current += 1;
      imageLayoutGenerationRef.current += 1;
      const pending = pendingDisplayResults.splice(0);
      for (const pendingResult of pending) {
        pendingResult.resolve(false);
      }
      settleAllDisplayCommits(false);
      for (const cancel of [...activeImageCheckCancels]) {
        cancel();
      }
      activeImageCheckCancels.clear();
      // キューをクリアして未再生アイテムを破棄
      queueRef.current = [];
      displayCommitBatches.clear();
      displayCommitEntries.clear();
      committedDrawIds.clear();
      activeDisplayInstanceIdRef.current = undefined;
      isDisplayingRef.current = false;
      playedSoundGroupIds.clear();
      if (connectionTimeoutRef.current) {
        clearTimeout(connectionTimeoutRef.current);
        connectionTimeoutRef.current = null;
      }
      if (terminalRecoveryReloadTimerRef.current) {
        clearTimeout(terminalRecoveryReloadTimerRef.current);
        terminalRecoveryReloadTimerRef.current = null;
      }
      if (cleanupRef.current) {
        cleanupRef.current();
      }
      if (animationTimeoutRef.current) {
        clearTimeout(animationTimeoutRef.current);
      }
      if (fallbackVisibilityTimeoutRef.current) {
        clearTimeout(fallbackVisibilityTimeoutRef.current);
        fallbackVisibilityTimeoutRef.current = null;
      }
    };
  }, [scheduleTerminalRecovery, settleAllDisplayCommits, streamerId]);

  // Demo function for testing
  // デモ機能 - 配信者のカードがあればそれを、なければデモカードを表示
  // cardIdが指定されている場合はそのカードを表示
  const triggerDemo = useCallback(async (cardId?: string) => {
    try {
      // Use demo endpoint which doesn't require authentication
      // streamerIdを渡して、配信者のカードを優先的に取得
      // cardIdが指定されている場合は特定のカードを取得
      const response = await fetch("/api/gacha/demo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ streamerId, cardId }),
      });

      if (response.ok) {
        const data = await response.json();
        enqueueResult(data);
      }
    } catch (error) {
      logger.error("Demo gacha error:", error);
    }
  }, [enqueueResult, streamerId]);

  // Check URL for demo param and optional cardId
  // URLパラメータでdemo=trueの場合にデモを実行、cardIdが指定されていればそのカードを表示
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get("demo") === "true") {
      // cardIdパラメータが指定されていれば特定のカードを表示
      const cardId = urlParams.get("cardId") || undefined;
      const timeoutId = setTimeout(() => {
        triggerDemo(cardId);
      }, 500);
      return () => clearTimeout(timeoutId);
    }
  }, [triggerDemo]);

  // Issue #638(回帰): レガシーミラー(soundEnabled && soundUrl)を「効果音が
  // 設定されているか」の判定に使うと、レアリティ別・報酬別ルールしか
  // 設定していない配信では常にfalseになり、自動再生ブロック時の案内
  // (Click to enable sound)が表示されなくなる。resolvePlayableGachaSound は
  // rarity/rewardIdのコンテキストを要求し表示判定には使えないため、ここでは
  // 「有効なルールが1件でもあるか」（ルール非空時）または従来どおりの
  // レガシーミラー判定（ルール空＝純レガシー設定時）で代用する。
  const hasPlayableSound = soundSettings.soundRules.length > 0
    ? soundSettings.soundRules.some((rule) => rule.enabled)
    : soundSettings.soundEnabled && !!soundSettings.soundUrl;

  if (!result) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-transparent">
        {/* 音声がブラウザの自動再生ポリシーでブロックされている場合の表示 */}
        {/* 通常の配信オーバーレイには運用メッセージを出さず、debug=true の調査時のみ表示する */}
        {options.debug && audioBlocked && hasPlayableSound && (
          <div className="fixed top-4 left-4 rounded bg-yellow-600/90 px-3 py-2 text-xs text-white cursor-pointer"
            onClick={() => {
              // クリックイベントはdocumentのunlockAudioハンドラーでも処理される
            }}
          >
            Click to enable sound / クリックで効果音を有効化
          </div>
        )}
        {/* デバッグモード：接続状態の詳細ログを表示 */}
        {/* OBSブラウザソースでの接続問題を調査するために使用 */}
        {/* URLに ?debug=true を追加すると表示される */}
        {options.debug && (
          <div className="fixed bottom-4 left-4 right-4 max-h-64 overflow-y-auto rounded bg-black/80 p-4 font-mono text-xs text-green-400">
            <div className="mb-2 text-white font-bold">Debug Mode - Connection Log</div>
            <div className="mb-2 text-yellow-400">
              Status: {connectionStatus} | StreamerId: {streamerId}
            </div>
            {/* #694 Stage 6b: maintenance状態はdebugパネルのみに出す固定表示欄。
                通常の配信オーバーレイ表示には一切影響しない。 */}
            <div className="mb-2 text-cyan-400">
              Maintenance: {maintenanceMode}
            </div>
            {errorMessage && (
              <div className="mb-2 text-yellow-300">
                Last issue: {errorMessage}
              </div>
            )}
            <div className="mb-2 text-gray-400">
              User Agent: {typeof navigator !== 'undefined' ? navigator.userAgent.slice(0, 80) + '...' : 'N/A'}
            </div>
            {debugLogs.map((log, index) => (
              <div key={index} className="whitespace-pre-wrap break-all">
                {log}
              </div>
            ))}
            {debugLogs.length === 0 && (
              <div className="text-gray-500">Waiting for logs...</div>
            )}
          </div>
        )}
      </div>
    );
  }

  const rarityColor = getRarityGradientClass(result.card.rarity);
  const rarityGlow = getRarityGlowClass(result.card.rarity);
  const rarityInfo = getRarityInfo(result.card.rarity);

  // 画像のみ表示モードかどうかを判定
  // imageOnlyが有効、またはautoPortraitが有効で縦長画像の場合
  const shouldShowImageOnly = options.imageOnly || (options.autoPortrait && isPortraitImage);

  // エフェクトを表示するかどうか。
  // レアリティ別に解決したスタイル（activeEffectStyle）が "none" 以外で、
  // かつパーティクルが生成されている場合のみ描画する。
  const shouldShowEffects = activeEffectStyle !== "none" && effectParticles.length > 0;

  const renderOverlayEffects = () => {
    if (!shouldShowEffects) {
      return null;
    }

    // スタイルごとのアニメーションクラスは src/lib/overlay-effect.ts の
    // OVERLAY_EFFECT_PARTICLE_CONFIG を Single Source of Truth として参照する。
    // パーティクルの色・サイズ・形状・軌道パラメータ（CSS変数）は生成時に
    // particle.visualStyle として個別に埋め込まれるため、ここでの描画は
    // スタイルに依存しない汎用ループになる（従来のスタイル別 if 分岐を廃止）。
    const config = OVERLAY_EFFECT_PARTICLE_CONFIG[activeEffectStyle];
    const animationClassName = config.animationClassName;

    return (
      <div
        className="pointer-events-none absolute inset-0 overflow-hidden"
        // スクリーンリーダーには無意味な装飾なので非読み上げに
        aria-hidden="true"
      >
        {effectParticles.map((particle, i) => (
          <div
            key={i}
            className={`absolute ${animationClassName}`}
            style={{
              left: particle.left,
              top: particle.top,
              animationDelay: particle.animationDelay,
              animationDuration: particle.animationDuration,
              ...particle.visualStyle,
            } as CSSProperties}
          >
            {particle.content}
          </div>
        ))}
      </div>
    );
  };

  // 小さい画像モード用のサイズクラス
  // smallModeオプションが有効で、かつ画像が400x400未満の場合のみカードサイズを縮小
  // これにより小さい画像でも適切なサイズで表示され、大きい画像は通常サイズで表示される
  const shouldUseSmallMode = options.smallMode && isSmallImage;
  const cardSizeClass = shouldUseSmallMode ? "w-48" : "w-80";
  const imageOnlySizeClass = shouldUseSmallMode ? "max-w-[192px] max-h-[268px]" : "max-w-[320px] max-h-[448px]";
  const showImageFallback = imageFallbackDisplayInstanceId === result.displayInstanceId;

  const renderImageFallback = (sizeClassName: string, overlay = false) => (
    <div
      data-overlay-card-fallback="true"
      role="img"
      aria-label={`${result.card.name} の画像を表示できないため代替表示`}
      className={`${overlay ? "pointer-events-none absolute inset-0 z-10" : ""} flex min-h-[192px] min-w-[192px] flex-col items-center justify-center rounded-lg bg-gray-700 px-4 py-6 text-center ${sizeClassName}`}
    >
      <span className={shouldUseSmallMode ? "text-4xl" : "text-6xl"}>🎴</span>
    </div>
  );

  return (
    <div className="flex h-screen w-screen items-center justify-center bg-transparent">
      <div
        key={result.displayInstanceId ?? `${result.historyId ?? "card"}:${result.card.id}`}
        data-overlay-card="true"
        data-overlay-display-instance={result.displayInstanceId ?? undefined}
        className={`transform transition-all duration-500 ${
          showCard ? "scale-100 opacity-100" : "scale-50 opacity-0"
        }`}
      >
        {shouldShowImageOnly ? (
          // 画像のみ表示モード（imageOnlyまたはautoPortraitでポートレイト画像の場合）
          // Image only mode: shows just the image without card frame
          // autoPortraitの場合は付帯情報オプションで追加情報を表示可能
          <div className="relative flex flex-col items-center">
            {/* ユーザー名（画像の上、オプションで表示） */}
            {/* Username above image (optional) */}
            {options.autoPortrait && isPortraitImage && options.portraitShowUsername && (
              <div className="mb-2 px-4 py-1 rounded-lg bg-gray-800/90 text-center">
                <span className={`text-gray-300 ${shouldUseSmallMode ? "text-xs" : "text-sm"}`}>
                  {result.userTwitchUsername} が引いたカード
                </span>
              </div>
            )}

            {/* 画像 */}
            {/* Issue #1076: 接続・イベント受信・演出切り替えは全て成功するのに
                OBS上でカード画素だけが表示されない(黒画面)事象への対策。
                next/imageは既定でloading="lazy"になり、OBSブラウザソース(CEF)
                ではその発火条件が満たされず永久に読み込まれない恐れがあるため、
                単体カード画像を即時読み込みにする。詳細な調査経緯・対抗仮説は
                Issue #1076参照。
                loading="eager"（`priority`ではなく）を使うのは、この画像が
                「カード表示が決まった瞬間に初めてマウントされる」ため、
                `priority`が付随して出すpreloadリンクの先読み効果が無く、
                長時間開きっぱなしのOBSページのheadへ不要なリンクを溜める
                だけになるため。 */}
            {result.card.image_url ? (
              <div className="relative">
                <Image
                  src={result.card.image_url}
                  alt={result.card.name}
                  width={shouldUseSmallMode ? 192 : 320}
                  height={shouldUseSmallMode ? 268 : 448}
                  className={`object-contain ${imageOnlySizeClass} rounded-lg shadow-2xl`}
                  unoptimized
                  loading="eager"
                />
                {showImageFallback && renderImageFallback("h-full w-full", true)}
              </div>
            ) : renderImageFallback(shouldUseSmallMode ? "w-48 h-48" : "w-80 h-80")}

            {/* 付帯情報（画像の下、オプションで表示） */}
            {/* Info section below image (optional, for autoPortrait mode) */}
            {options.autoPortrait && isPortraitImage && (
              options.portraitShowName || options.portraitShowRarity || options.portraitShowDescription
            ) && (
              <div className={`mt-2 px-4 py-2 rounded-lg bg-gray-800/90 ${shouldUseSmallMode ? "max-w-[192px]" : "max-w-[320px]"}`}>
                {/* カード名とレアリティ */}
                {(options.portraitShowName || options.portraitShowRarity) && (
                  <div className="flex items-center justify-center gap-2 flex-wrap">
                    {options.portraitShowName && (
                      <span className={`text-white font-semibold ${shouldUseSmallMode ? "text-sm" : "text-base"}`}>
                        {result.card.name}
                      </span>
                    )}
                    {options.portraitShowRarity && (
                      <span
                        className={`rounded-full px-2 py-0.5 text-white ${shouldUseSmallMode ? "text-[10px]" : "text-xs"} ${rarityInfo.color}`}
                      >
                        {rarityInfo.label}
                      </span>
                    )}
                  </div>
                )}
                {/* 説明文 */}
                {options.portraitShowDescription && result.card.description && (
                  <p className={`text-gray-300 text-center line-clamp-2 ${shouldUseSmallMode ? "text-xs mt-1" : "text-sm mt-2"}`}>
                    {result.card.description}
                  </p>
                )}
              </div>
            )}

            {renderOverlayEffects()}
          </div>
        ) : (
          // 通常のカード表示モード
          // Normal card display mode with frame and text
          <>
            {/* Card Container - matches Collection style */}
            <div
              className={`relative ${cardSizeClass} overflow-hidden rounded-2xl bg-gradient-to-br ${rarityColor} p-1 shadow-2xl ${rarityGlow}`}
            >
              <div className="rounded-xl bg-gray-700 overflow-hidden">
                {/* User Info */}
                <div className="bg-gray-800 py-2 text-center">
                  <span className={`text-gray-400 ${shouldUseSmallMode ? "text-xs" : "text-sm"}`}>
                    {result.userTwitchUsername} が引いたカード
                  </span>
                </div>

                {/* Card Name and Rarity - on top like Collection */}
                <div className={shouldUseSmallMode ? "p-2 pb-1" : "p-3 pb-2"}>
                  <div className="flex items-center justify-between">
                    <h2 className={`font-semibold text-white truncate ${shouldUseSmallMode ? "text-sm" : "text-lg"}`}>
                      {result.card.name}
                    </h2>
                    <span
                      className={`rounded-full px-2 py-0.5 text-white shrink-0 ml-2 ${shouldUseSmallMode ? "text-[10px]" : "text-xs"} ${rarityInfo.color}`}
                    >
                      {rarityInfo.label}
                    </span>
                  </div>
                </div>

                {/* Card Image - square like Collection */}
                <div className="aspect-square bg-gray-600">
                  {result.card.image_url ? (
                    <div className="relative h-full w-full">
                      {/* unoptimized: ImageCropperで400x400px・JPEG85%に最適化済みのため、Vercel Image Transformationsをスキップしてコスト削減
                          loading="eager": Issue #1076参照(画像のみモード側の同コメント参照)。
                          通常モードのカード画像も同じ理由で即時読み込みにする。 */}
                      <Image
                        src={result.card.image_url}
                        alt={result.card.name}
                        width={shouldUseSmallMode ? 180 : 300}
                        height={shouldUseSmallMode ? 180 : 300}
                        className={`w-full h-full ${cardImageFitClass(result.card.image_padding_color)}`}
                        style={cardImageFitStyle(result.card.image_padding_color)}
                        unoptimized
                        loading="eager"
                      />
                      {showImageFallback && renderImageFallback("h-full w-full", true)}
                    </div>
                  ) : renderImageFallback("h-full w-full")}
                </div>

                {/* Description - below image like Collection */}
                {result.card.description && (
                  <div className={shouldUseSmallMode ? "p-2 pt-1" : "p-3 pt-2"}>
                    <p className={`text-gray-300 line-clamp-2 ${shouldUseSmallMode ? "text-xs" : "text-sm"}`}>
                      {result.card.description}
                    </p>
                  </div>
                )}
              </div>
            </div>

            {renderOverlayEffects()}
          </>
        )}
      </div>
    </div>
  );
}
