"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useParams } from "next/navigation";
import Image from "next/image";
import type { Card, Rarity } from "@/types/database";
import { logger } from "@/lib/logger";
import { subscribeToGachaResults } from "@/lib/realtime";
import { type OverlayEffectStyle, normalizeOverlayEffectStyle } from "@/lib/overlay-effect";
import { getRarityGlowClass, getRarityGradientClass, getRarityDisplayInfo } from "@/lib/rarity";

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
}

interface OverlayPollingEvent {
  id: string;
  eventId: string | null;
  redeemedAt: string;
  userTwitchUsername: string;
  card: Pick<Card, "id" | "name" | "description" | "image_url" | "rarity">;
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

interface SparklePosition {
  left: string;
  top: string;
  animationDelay: string;
  animationDuration: string;
}

// 共有定義に集約: src/lib/overlay-effect.ts を Single Source of Truth とする
function parseOverlayEffectStyle(value: string | null): OverlayEffectStyle {
  return normalizeOverlayEffectStyle(value);
}

/**
 * Overlay display options controlled via URL parameters
 * URLパラメータで制御されるオーバーレイ表示オプション
 * - imageOnly: 画像のみ表示（カード枠・テキストなし）
 * - autoPortrait: 縦長画像を自動検出してオリジナル画像表示
 * - effects: レジェンダリーのキラキラエフェクト表示（デフォルト: true）
 * - effectStyle: エフェクトの種類（sparkle/confetti/hearts、デフォルト: sparkle）
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
  effectStyle: OverlayEffectStyle;
  smallMode: boolean;
  displayDuration: number;  // カードの表示時間（秒）、デフォルト6秒
  debug: boolean;
  // 縦長画像の付帯情報表示オプション（画像に被らず表示）
  portraitShowName: boolean;
  portraitShowRarity: boolean;
  portraitShowDescription: boolean;
  portraitShowUsername: boolean;
}

// Generate sparkle positions outside of render
function generateSparklePositions(): SparklePosition[] {
  return [...Array(20)].map(() => ({
    left: `${Math.random() * 100}%`,
    top: `${Math.random() * 100}%`,
    animationDelay: `${Math.random() * 2}s`,
    animationDuration: `${1 + Math.random()}s`,
  }));
}

export default function OverlayPage() {
  const params = useParams();
  const streamerId = params.streamerId as string;
  const [result, setResult] = useState<GachaResult | null>(null);
  const [showCard, setShowCard] = useState(false);
  const [sparklePositions, setSparklePositions] = useState<SparklePosition[]>([]);
  const [connectionStatus, setConnectionStatus] = useState<'connecting' | 'connected' | 'disconnected' | 'error'>('connecting');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // オーバーレイ表示オプション（URLパラメータで設定）
  // autoPortraitとsmallModeはデフォルトでtrue（より良い表示体験のため）
  const [options, setOptions] = useState<OverlayOptions>({
    imageOnly: false,
    autoPortrait: true,  // デフォルトでポートレイト画像を自動検出
    effects: true,
    effectStyle: "sparkle",
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
  }>({ soundUrl: null, soundEnabled: true });
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
  // 効果音再生用のオーディオ要素への参照
  // HTMLAudioElementを使用（R2パブリックURLはCORSヘッダーがないためfetch不可、
  // audioタグはCORS不要で読み込める）
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // ユーザー操作により音声再生がアンロック済みかどうか
  // ブラウザの自動再生ポリシーにより、最初のユーザー操作までplay()は失敗する
  const audioUnlockedRef = useRef(false);
  // 音声がブラウザのAutoplayポリシーでブロックされているかどうか（UI表示用）
  const [audioBlocked, setAudioBlocked] = useState(false);

  useEffect(() => {
    connectionStatusRef.current = connectionStatus;
  }, [connectionStatus]);

  // 効果音設定を取得し、HTMLAudioElementでプリロード
  // オーバーレイ初期化時にstreamerの効果音設定をAPIから取得
  // 認証不要のパブリックエンドポイントを使用
  useEffect(() => {
    const fetchSoundSettings = async () => {
      try {
        const response = await fetch(`/api/streamer/${streamerId}/sound-settings`);
        if (response.ok) {
          const data = await response.json();
          setSoundSettings({
            soundUrl: data.soundUrl,
            soundEnabled: data.soundEnabled ?? true,
          });
          // 効果音URLが設定されている場合、Audio要素を作成してプリロード
          // HTMLAudioElementはCORS不要で外部URLから読み込める（fetchとは異なる）
          if (data.soundUrl && data.soundEnabled) {
            const audio = new Audio(data.soundUrl);
            audio.preload = "auto";
            audioRef.current = audio;

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
      const audio = audioRef.current;
      if (audio) {
        // ユーザー操作のコンテキスト内でplay()を呼ぶことでブラウザのロックを解除
        // Calling play() within user gesture context unlocks browser's autoplay restriction
        audio.play().then(() => {
          audio.pause();
          audio.currentTime = 0;
          audioUnlockedRef.current = true;
          setAudioBlocked(false);
          logger.info("Audio unlocked after user interaction");
        }).catch(() => {
          // まだアンロックできない場合は次のクリックで再試行
        });
      }
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
        effectStyle: parseOverlayEffectStyle(urlParams.get("effect")),
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
  const playGachaSound = useCallback(() => {
    // 効果音が無効または未設定の場合はスキップ
    if (!soundSettings.soundEnabled || !soundSettings.soundUrl) {
      return;
    }

    try {
      if (audioRef.current) {
        // プリロード済みのAudio要素を使用して再生
        audioRef.current.currentTime = 0;
        audioRef.current.play().catch(() => {
          // 自動再生ポリシーによりブロックされた場合は無視
          // ユーザーがページをクリックすればアンロックされ、次回から再生可能
        });
      }
    } catch (error) {
      logger.error("Error playing gacha sound:", error);
    }
  }, [soundSettings.soundEnabled, soundSettings.soundUrl]);

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

    setSparklePositions(generateSparklePositions());
    setResult(next);
    setShowCard(false);

    // Show card after brief delay
    animationTimeoutRef.current = setTimeout(() => {
      setShowCard(true);
      if (next.shouldPlaySound !== false) {
        if (next.soundGroupId) {
          if (!playedSoundGroupIdsRef.current.has(next.soundGroupId)) {
            playedSoundGroupIdsRef.current.add(next.soundGroupId);
            playGachaSound();
          }
        } else {
          playGachaSound();
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
  }, [checkImageAspectRatio, playGachaSound, options.displayDuration]);

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
    queueRef.current.push(
      ...cards.map((card, index) => ({
        ...data,
        card,
        cards: undefined,
        shouldPlaySound: data.shouldPlaySound !== false && index === 0,
      }))
    );
    if (!isDisplayingRef.current) {
      processQueue();
    }
  }, [processQueue]);

  // refを最新のcallbackで更新（useEffectの依存配列に含めずに最新の関数を参照するため）
  useEffect(() => {
    displayResultRef.current = enqueueResult;
  }, [enqueueResult]);

  /**
   * Realtime が購読できない環境向けの polling fallback。
   * Supabase Realtime の public channel join が CHANNEL_ERROR になる場合でも、
   * ガチャ履歴から overlay 表示を継続できるようにする。
   */
  const pollOverlayEvents = useCallback(async () => {
    if (connectionStatusRef.current === "connected") {
      return;
    }

    try {
      const url = new URL(`/api/overlay/${streamerId}/events`, window.location.origin);
      url.searchParams.set("since", pollCursorRef.current);
      url.searchParams.set("_", String(Date.now()));

      const data = await fetchJsonWithXhrFallback<{ events?: OverlayPollingEvent[] }>(url.toString());
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
  }, [streamerId]);

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

  // エフェクトを表示するかどうか（オプションで無効化されていない場合のみ）
  const shouldShowEffects = options.effects && result.card.rarity === "legendary";

  const renderOverlayEffects = () => {
    if (!shouldShowEffects) {
      return null;
    }

    // i * 23deg: 23 は 360 と互いに素な素数のため、N=20 個並べても回転角が均等に
    // 散らばり (周期 360°) 偏りが目立たない。色も 4 色を i%4 で循環させ、視覚的な
    // ランダム感を低コストで演出する（CSS 1行で済ませる狙い）。
    const CONFETTI_ROTATION_STEP_DEG = 23;
    return (
      <div
        className="pointer-events-none absolute inset-0 overflow-hidden"
        // スクリーンリーダーには無意味な装飾なので非読み上げに
        aria-hidden="true"
      >
        {sparklePositions.map((pos, i) => {
          if (options.effectStyle === "confetti") {
            return (
              <div
                key={i}
                className={`absolute h-2.5 w-1.5 animate-bounce rounded-sm ${
                  i % 4 === 0
                    ? "bg-yellow-300"
                    : i % 4 === 1
                      ? "bg-pink-400"
                      : i % 4 === 2
                        ? "bg-cyan-300"
                        : "bg-purple-400"
                }`}
                style={{ ...pos, transform: `rotate(${i * CONFETTI_ROTATION_STEP_DEG}deg)` }}
              />
            );
          }

          return (
            <div
              key={i}
              className={`absolute ${
                options.effectStyle === "hearts" ? "animate-bounce text-pink-300" : "animate-ping"
              }`}
              style={pos}
            >
              {options.effectStyle === "hearts" ? "♥" : "✨"}
            </div>
          );
        })}
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
