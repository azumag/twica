"use client";

import { useEffect, useState, useCallback, useRef, type CSSProperties } from "react";
import { useParams } from "next/navigation";
import Image from "next/image";
import type { Card, Rarity } from "@/types/database";
import { logger } from "@/lib/logger";
import { subscribeToGachaResults } from "@/lib/realtime";
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
import {
  normalizeGachaSoundRules,
  pickGachaSoundRule,
  pickSoundBearingCardIndex,
  type GachaSoundRule,
} from "@/lib/gacha-sound-rules";
import {
  shouldScheduleReload,
  isReloadCooldownActive,
  serializePollState,
  parsePollState,
  parseReloadCooldownRecord,
  RELOAD_COOLDOWN_MS,
  POLLSTATE_TTL_MS,
} from "@/lib/overlay-version";

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
}

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

// Issue #569: バージョン確認・自動リロード関連の時間定数。
// 「10分」は設計上、(1)Realtime接続中にバージョン確認だけを行う間隔 と
// (2)不一致検出からリロード実行までのランダムジッター上限 の両方に使われるため
// 定数を共有する。
const TEN_MINUTES_MS = 10 * 60 * 1000;
// 演出中で実行を見送った場合の再試行間隔(演出を壊さないための待ち時間)
const RELOAD_DEFER_RETRY_MS = 30 * 1000;

// sessionStorage キー。リロード前後で状態を引き継ぐために使う
const RELOAD_COOLDOWN_STORAGE_KEY = "twica-overlay-reload";
const POLLSTATE_STORAGE_KEY = "twica-overlay-pollstate";

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
  // 画像のアスペクト比が縦長かどうかを判定するためのState
  const [isPortraitImage, setIsPortraitImage] = useState(false);
  // 画像が小さい（400x400未満）かどうかを判定するためのState
  // 小さい画像の場合はsmallModeを自動適用するために使用
  const [isSmallImage, setIsSmallImage] = useState(false);
  // ガチャ効果音設定
  // streamerから取得した効果音URLと有効/無効状態を保持
  const [soundSettings, setSoundSettings] = useState<{
    soundUrl: string | null;
    soundEnabled: boolean;
    soundRules: GachaSoundRule[];
  }>({ soundUrl: null, soundEnabled: true, soundRules: [] });
  const animationTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const connectionStatusRef = useRef(connectionStatus);
  // ガチャ結果キュー: アニメーション中に到着した結果をバッファし順番に表示する
  // 連続引き換え時に前のカードが消えて最後の1件しか表示されない問題を解消
  const queueRef = useRef<GachaResult[]>([]);
  const isDisplayingRef = useRef(false);
  const playedSoundGroupIdsRef = useRef<Set<string>>(new Set());
  // processQueueの再帰呼び出し用ref（useCallback内で自身を参照するため）
  const processQueueRef = useRef<() => void>(() => {});
  // displayResultとaddDebugLogをrefで保持することで、
  // subscriptionのuseEffectが不要に再実行されることを防ぐ
  // （soundSettings変更 → playGachaSound再生成 → displayResult再生成 のチェーンで
  //  subscriptionが破棄・再作成される問題を回避）
  const displayResultRef = useRef<(data: GachaResult) => void>(() => {});
  const addDebugLogRef = useRef<(message: string) => void>(() => {});
  const connectionTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollCursorRef = useRef(new Date().toISOString());
  const seenHistoryIdsRef = useRef<Set<string>>(new Set());
  const lastPollingErrorLogRef = useRef(0);
  // Issue #569: バージョン不一致検出＋自動リロード用のref群。
  // showCardは演出中判定にrefで参照する必要がある(setTimeoutコールバック内で
  // stateを直接読むとクロージャ生成時点の古い値のままになるため)。
  const showCardRef = useRef(showCard);
  // Realtime接続中にバージョン確認だけを行う最終実行時刻(10分に1回に絞るため)。
  // 0で初期化し、接続後最初のポーリングTickで即座に1回だけ確認を行う(以降は
  // 10分間隔に絞られる)。Date.now()はレンダー中に呼べない(React Compilerの
  // purityルールで検出される)ため、ここでは呼ばずrefの初期値は0固定にする。
  const lastVersionCheckAtRef = useRef(0);
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
  // 音声がブラウザのAutoplayポリシーでブロックされているかどうか（UI表示用）
  const [audioBlocked, setAudioBlocked] = useState(false);

  useEffect(() => {
    connectionStatusRef.current = connectionStatus;
  }, [connectionStatus]);

  // Issue #569: showCardをrefにミラーする(setTimeoutコールバック内で
  // 「今演出中かどうか」を古いクロージャ値ではなく最新値で判定するため)
  useEffect(() => {
    showCardRef.current = showCard;
  }, [showCard]);

  // Issue #569: マウント時、直前のバージョン起因リロードでpollCursor/
  // seenHistoryIdsをsessionStorageに退避していた場合はここで復元する。
  // TTL(15分)超過や壊れたJSONの場合はparsePollStateがnullを返すため、
  // その場合は何も復元されず通常どおり「今」を起点にポーリングを開始する。
  // このeffectは他のeffect(ポーリングスケジューラ・Realtime購読)より前に
  // 定義しているため、それらが最初に動く前に確実に復元が完了する。
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(POLLSTATE_STORAGE_KEY);
      const restored = parsePollState(raw, Date.now(), POLLSTATE_TTL_MS);
      if (restored) {
        pollCursorRef.current = restored.pollCursor;
        seenHistoryIdsRef.current = new Set(restored.seenHistoryIds);
      }
      // 復元の成否に関わらず使用後(またはTTL切れ)は必ず削除し、残骸を残さない
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
  }, []);

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

          if (soundEnabled) {
            // 再生され得る全URL（ルールごと + レガシー単一URL）を収集して
            // それぞれHTMLAudioElementを作成しプリロードする。
            // HTMLAudioElementはCORS不要で外部URLから読み込める（fetchとは異なる）。
            // key: ruleId、レガシーURLは固定キー "__legacy__" を使う。
            const cache = audioCacheRef.current;
            const entries: { key: string; url: string }[] = [];
            for (const rule of soundRules) {
              if (rule.enabled && rule.url) {
                entries.push({ key: rule.id, url: rule.url });
              }
            }
            if (data.soundUrl) {
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
  // Promiseを返すことで、画像ロード完了を待てるようにする
  const checkImageAspectRatio = useCallback((imageUrl: string | null): Promise<boolean> => {
    return new Promise((resolve) => {
      if (!imageUrl) {
        setIsPortraitImage(false);
        setIsSmallImage(false);
        resolve(false);
        return;
      }

      const img = new window.Image();
      img.onload = () => {
        // 画像の縦が横より大きい（正方形でない縦長画像）の場合はポートレイト
        // Portrait if height is greater than width (not a square)
        const isPortrait = img.height > img.width;
        setIsPortraitImage(isPortrait);

        // 画像が400x400未満の場合は小さい画像として判定
        // 小さい画像モードを自動適用するために使用
        const isSmall = img.width < 400 && img.height < 400;
        setIsSmallImage(isSmall);

        resolve(isPortrait);
      };
      img.onerror = () => {
        setIsPortraitImage(false);
        setIsSmallImage(false);
        resolve(false);
      };
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
    // 効果音が無効または未設定の場合はスキップ
    const selectedRule = pickGachaSoundRule(soundSettings.soundRules, {
      rarity: data.card.rarity,
      rewardId: data.rewardId,
    });
    // PR #451 レビュー指摘(F1b): soundRules が1件以上ある(=このクライアントは
    // ルールベースの音を理解している)のにどのルールにも一致しなかった場合、
    // 「何も鳴らさない」が正しい挙動。以前はここで soundSettings.soundUrl
    // (サーバー側がミラーしていた「有効な最初のルール」のURL)にフォール
    // バックしていたため、例えば'legendary'限定ルールしか設定していない
    // 配信でも、それ以外の全レアリティでレジェンダリー音が鳴ってしまって
    // いた(サーバー側 F1 のミラー修正とセットで直る問題)。
    // レガシー設定(soundRulesが空=ルール未対応の単一URL設定)の場合のみ、
    // 従来どおり soundUrl にフォールバックする。
    const soundUrl = soundSettings.soundRules.length > 0
      ? (selectedRule?.url ?? null)
      : soundSettings.soundUrl;
    if (!soundSettings.soundEnabled || !soundUrl) {
      return;
    }

    try {
      // ルールに対応するプリロード済みAudio要素を優先的に使用する。
      // ルールが選択された場合は rule.id、レガシー単一URLの場合は固定キー。
      const cacheKey = selectedRule?.id ?? "__legacy__";
      const cached = audioCacheRef.current.get(cacheKey);
      if (cached && cached.src === soundUrl) {
        // プリロード済みのAudio要素を使用して再生
        cached.currentTime = 0;
        cached.play().catch(() => {
          // 自動再生ポリシーによりブロックされた場合は無視
          // ユーザーがページをクリックすればアンロックされ、次回から再生可能
        });
      } else {
        // キャッシュ未生成（取得タイミング差など）のフォールバック
        const audio = new Audio(soundUrl);
        audio.play().catch(() => {});
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
    const next = queueRef.current.shift();
    if (!next) {
      isDisplayingRef.current = false;
      return;
    }
    isDisplayingRef.current = true;

    // 画像のアスペクト比をチェック（autoPortraitモード用）
    await checkImageAspectRatio(next.card.image_url);

    // このカードのレアリティに紐づくエフェクトを解決する。
    // effects スイッチが OFF なら常に "none"（全レアリティ無効）。
    const resolvedStyle = options.effects
      ? resolveEffectForRarity(options.rarityEffectMap, next.card.rarity)
      : "none";
    setActiveEffectStyle(resolvedStyle);
    setEffectParticles(generateOverlayEffectParticles(resolvedStyle));
    setResult(next);
    setShowCard(false);

    // Show card after brief delay
    animationTimeoutRef.current = setTimeout(() => {
      setShowCard(true);
      if (next.shouldPlaySound !== false) {
        if (next.soundGroupId) {
          if (!playedSoundGroupIdsRef.current.has(next.soundGroupId)) {
            playedSoundGroupIdsRef.current.add(next.soundGroupId);
            playGachaSound(next);
          }
        } else {
          playGachaSound(next);
        }
      }

      // Hide after display, then process next queued item
      animationTimeoutRef.current = setTimeout(() => {
        setShowCard(false);
        animationTimeoutRef.current = setTimeout(() => {
          setResult(null);
          // ref経由で最新のprocessQueueを呼び出し（再帰）
          processQueueRef.current();
        }, 500);
      }, options.displayDuration * 1000);
    }, 100);
  }, [checkImageAspectRatio, playGachaSound, options.displayDuration, options.effects, options.rarityEffectMap]);

  // processQueueRefを最新のcallbackで更新
  useEffect(() => {
    processQueueRef.current = processQueue;
  }, [processQueue]);

  /**
   * 新しいガチャ結果をキューに追加し、未再生なら再生を開始する
   * Enqueue a new gacha result; start playback if idle
   */
  const enqueueResult = useCallback((data: GachaResult) => {
    const cards = data.cards?.length ? data.cards : [data.card];
    // PR #451 レビュー指摘(F2): 「1枚目のカード」固定ではなく、バッチ全体から
    // ルール一致優先度(reward > rarity > all、同率ならより希少なレアリティ)が
    // 最も高い1枚を選んで、そのカードの表示タイミングでのみ音を鳴らす。
    // 上位から明示的に shouldPlaySound: false が来ている場合はバッチ全体を
    // 無音にする(現状これを設定する呼び出し元は無いが、既存の安全弁として維持)。
    const soundBearingIndex = data.shouldPlaySound === false
      ? -1
      : pickSoundBearingCardIndex(cards, data.rewardId, soundSettings.soundRules);
    queueRef.current.push(
      ...cards.map((card, index) => ({
        ...data,
        card,
        cards: undefined,
        shouldPlaySound: index === soundBearingIndex,
      }))
    );
    if (!isDisplayingRef.current) {
      processQueue();
    }
  }, [processQueue, soundSettings.soundRules]);

  // refを最新のcallbackで更新（useEffectの依存配列に含めずに最新の関数を参照するため）
  useEffect(() => {
    displayResultRef.current = enqueueResult;
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
    // 30秒後に同じ判定をやり直す(設計上の要件3番)
    const isMidDisplay =
      isDisplayingRef.current || queueRef.current.length > 0 || showCardRef.current;
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
    // JSONの形状検証はparseReloadCooldownRecord(overlay-version.ts)に委譲し、
    // parsePollStateと同じ「壊れたデータでも例外を投げずnullを返す」方針に揃える)
    let cooldownRecord: ReturnType<typeof parseReloadCooldownRecord> = null;
    try {
      cooldownRecord = parseReloadCooldownRecord(sessionStorage.getItem(RELOAD_COOLDOWN_STORAGE_KEY));
    } catch {
      cooldownRecord = null;
    }

    if (isReloadCooldownActive(cooldownRecord, targetVersion, Date.now(), RELOAD_COOLDOWN_MS)) {
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
        JSON.stringify({ version: targetVersion, reloadedAt: Date.now() }),
      );
      sessionStorage.setItem(
        POLLSTATE_STORAGE_KEY,
        serializePollState({
          pollCursor: pollCursorRef.current,
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
  }, []);

  // attemptReloadRefを最新のcallbackで更新(processQueueRefと同じパターン)
  useEffect(() => {
    attemptReloadRef.current = attemptReload;
  }, [attemptReload]);

  /**
   * Issue #569: ポーリング応答のoverlayVersionを自身のビルドバージョンと比較し、
   * 不一致ならリロードをスケジュールする。
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
    // 一斉リロード→同時アクセス集中が起きないよう、0〜10分でランダムに散らす
    const jitterMs = Math.floor(Math.random() * TEN_MINUTES_MS);
    reloadTimeoutRef.current = setTimeout(() => {
      attemptReload();
    }, jitterMs);
  }, [attemptReload]);

  /**
   * Realtime が購読できない環境向けの polling fallback。
   * Supabase Realtime の public channel join が CHANNEL_ERROR になる場合でも、
   * ガチャ履歴から overlay 表示を継続できるようにする。
   */
  const pollOverlayEvents = useCallback(async () => {
    // 3秒おきのポーリングURLは接続中/未接続どちらの経路でも同一なため共通化する
    const buildEventsUrl = () => {
      const url = new URL(`/api/overlay/${streamerId}/events`, window.location.origin);
      url.searchParams.set("since", pollCursorRef.current);
      url.searchParams.set("_", String(Date.now()));
      return url.toString();
    };

    if (connectionStatusRef.current === "connected") {
      // Issue #569: Realtime接続中もこの関数は3秒おきに呼ばれ続けるが、
      // 従来は何もせず早期returnしていた。ここに「10分に1回、バージョン確認だけ
      // 行う」経路を追加する。
      // 理由: Realtime受信イベントにはhistoryId/eventIdが無くseenHistoryIdsRefに
      // 登録されないため、接続中にevents配列を処理すると同一演出がポーリング
      // 経路からも再生され二重演出になる。そのため接続中は応答のoverlayVersion
      // だけを読み、events配列には一切触れない(表示・カーソル前進・seen登録の
      // いずれも行わない)。
      const now = Date.now();
      if (now - lastVersionCheckAtRef.current < TEN_MINUTES_MS) {
        return;
      }
      lastVersionCheckAtRef.current = now;

      try {
        const data = await fetchJsonWithXhrFallback<{ overlayVersion?: string }>(buildEventsUrl());
        checkOverlayVersion(data.overlayVersion);
      } catch {
        // バージョン確認専用の背景チェックであり演出表示には無関係なため、
        // 失敗時はログを出さず静かに次の10分後の機会に委ねる
      }
      return;
    }

    try {
      const data = await fetchJsonWithXhrFallback<{
        events?: OverlayPollingEvent[];
        overlayVersion?: string;
      }>(buildEventsUrl());
      checkOverlayVersion(data.overlayVersion);
      const events = data.events ?? [];
      for (const event of events) {
        if (seenHistoryIdsRef.current.has(event.id)) {
          continue;
        }
        seenHistoryIdsRef.current.add(event.id);
        const redeemedAtMs = Date.parse(event.redeemedAt);
        pollCursorRef.current = Number.isFinite(redeemedAtMs)
          ? new Date(redeemedAtMs).toISOString()
          : event.redeemedAt;
        addDebugLogRef.current(`Polling fallback received: ${event.id}`);
        displayResultRef.current({
          card: event.card as Card,
          userTwitchUsername: event.userTwitchUsername,
          historyId: event.id,
          soundGroupId: event.eventId?.replace(/:\d+$/, "") ?? event.id,
          rewardId: event.rewardId ?? null,
        });
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
        await pollOverlayEvents();
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

  // Connect to Supabase Realtime for real-time events
  // 依存配列は streamerId のみ。displayResult/addDebugLog は ref 経由で参照し、
  // callback の再生成（soundSettings 変更等）で subscription が破棄・再作成されないようにする
  useEffect(() => {
    const playedSoundGroupIds = playedSoundGroupIdsRef.current;

    queueMicrotask(() => {
      addDebugLogRef.current(`Starting subscription for streamer: ${streamerId}`);
      addDebugLogRef.current(`Supabase URL: ${process.env.NEXT_PUBLIC_SUPABASE_URL ? 'configured' : 'missing'}`);
    });

    const cleanup = subscribeToGachaResults(streamerId, (payload) => {
      addDebugLogRef.current(`Received payload: ${payload.type}`);
      if (payload.type === 'gacha' && payload.card) {
        // Avoid replaying the same event through polling if Realtime later drops.
        pollCursorRef.current = new Date().toISOString();
        displayResultRef.current({
          card: payload.card as unknown as Card,
          cards: payload.cards as unknown as Card[] | undefined,
          userTwitchUsername: payload.userTwitchUsername,
          rewardId: payload.rewardId ?? null,
        });
      }
    }, {
      onError: (error) => {
        addDebugLogRef.current(`Connection error: ${error.message} (expected: ${error.isExpected})`);
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
        setConnectionStatus('connected');
        if (connectionTimeoutRef.current) {
          clearTimeout(connectionTimeoutRef.current);
          connectionTimeoutRef.current = null;
        }
      },
      onStatusChange: (status) => {
        addDebugLogRef.current(`Connection status: ${status}`);
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
      // キューをクリアして未再生アイテムを破棄
      queueRef.current = [];
      isDisplayingRef.current = false;
      playedSoundGroupIds.clear();
      if (connectionTimeoutRef.current) {
        clearTimeout(connectionTimeoutRef.current);
      }
      if (cleanupRef.current) {
        cleanupRef.current();
      }
      if (animationTimeoutRef.current) {
        clearTimeout(animationTimeoutRef.current);
      }
    };
  }, [streamerId]);

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

  if (!result) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-transparent">
        {/* 音声がブラウザの自動再生ポリシーでブロックされている場合の表示 */}
        {/* 通常の配信オーバーレイには運用メッセージを出さず、debug=true の調査時のみ表示する */}
        {options.debug && audioBlocked && soundSettings.soundEnabled && soundSettings.soundUrl && (
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

  return (
    <div className="flex h-screen w-screen items-center justify-center bg-transparent">
      <div
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
            {result.card.image_url ? (
              <Image
                src={result.card.image_url}
                alt={result.card.name}
                width={shouldUseSmallMode ? 192 : 320}
                height={shouldUseSmallMode ? 268 : 448}
                className={`object-contain ${imageOnlySizeClass} rounded-lg shadow-2xl`}
                unoptimized
              />
            ) : (
              <div className={`flex items-center justify-center bg-gray-700 rounded-lg ${shouldUseSmallMode ? "w-48 h-48" : "w-80 h-80"}`}>
                <span className={shouldUseSmallMode ? "text-4xl" : "text-6xl"}>🎴</span>
              </div>
            )}

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
                    // unoptimized: ImageCropperで400x400px・JPEG85%に最適化済みのため、Vercel Image Transformationsをスキップしてコスト削減
                    <Image
                      src={result.card.image_url}
                      alt={result.card.name}
                      width={shouldUseSmallMode ? 180 : 300}
                      height={shouldUseSmallMode ? 180 : 300}
                      className="w-full h-full object-cover"
                      unoptimized
                    />
                  ) : (
                    <div className="flex h-full items-center justify-center">
                      <span className={shouldUseSmallMode ? "text-4xl" : "text-6xl"}>🎴</span>
                    </div>
                  )}
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
