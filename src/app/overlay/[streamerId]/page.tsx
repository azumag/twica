"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useParams } from "next/navigation";
import Image from "next/image";
import type { Card, Rarity } from "@/types/database";
import { logger } from "@/lib/logger";
import { subscribeToGachaResults } from "@/lib/realtime";
import { RARITIES, RARITY_GRADIENT_COLORS, RARITY_GLOW } from "@/lib/constants";

/**
 * Get rarity information (label and color) for a given rarity value
 * 指定されたレアリティ値のレアリティ情報（ラベルと色）を取得
 */
const getRarityInfo = (rarity: Rarity) =>
  RARITIES.find((r) => r.value === rarity) || RARITIES[0];

interface GachaResult {
  card: Card;
  userTwitchUsername: string;
}

interface SparklePosition {
  left: string;
  top: string;
  animationDelay: string;
  animationDuration: string;
}

/**
 * Overlay display options controlled via URL parameters
 * URLパラメータで制御されるオーバーレイ表示オプション
 * - imageOnly: 画像のみ表示（カード枠・テキストなし）
 * - autoPortrait: 縦長画像を自動検出してオリジナル画像表示
 * - effects: レジェンダリーのキラキラエフェクト表示（デフォルト: true）
 * - smallMode: 小さい画像用の縮小表示モード
 */
interface OverlayOptions {
  imageOnly: boolean;
  autoPortrait: boolean;
  effects: boolean;
  smallMode: boolean;
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
    smallMode: true,     // デフォルトで小さい画像モードを有効化
  });
  // 画像のアスペクト比が縦長かどうかを判定するためのState
  const [isPortraitImage, setIsPortraitImage] = useState(false);
  // 画像が小さい（400x400未満）かどうかを判定するためのState
  // 小さい画像の場合はsmallModeを自動適用するために使用
  const [isSmallImage, setIsSmallImage] = useState(false);
  const animationTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const connectionStatusRef = useRef(connectionStatus);
  const connectionTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    connectionStatusRef.current = connectionStatus;
  }, [connectionStatus]);

  // URLパラメータからオーバーレイオプションを解析
  // Parse overlay options from URL parameters
  // autoPortrait, smallMode, effectsはデフォルトでtrue（falseの場合のみURLパラメータで明示）
  // queueMicrotaskを使用してsetStateを非同期に実行し、カスケードレンダーを回避
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    // 非同期に実行してuseEffect内での同期的なsetState呼び出しを回避
    // Defer setState to avoid synchronous state update in effect body
    queueMicrotask(() => {
      setOptions({
        imageOnly: urlParams.get("imageOnly") === "true",
        autoPortrait: urlParams.get("autoPortrait") !== "false",  // デフォルトはtrue
        effects: urlParams.get("effects") !== "false",             // デフォルトはtrue
        smallMode: urlParams.get("smallMode") !== "false",         // デフォルトはtrue
      });
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

  // Display gacha result with animation
  const displayResult = useCallback(async (data: GachaResult) => {
    // Clear any existing animation
    if (animationTimeoutRef.current) {
      clearTimeout(animationTimeoutRef.current);
    }

    // 画像のアスペクト比をチェック（autoPortraitモード用）
    // 画像ロードが完了するまで待機してから表示を開始
    await checkImageAspectRatio(data.card.image_url);

    // Generate sparkle positions
    setSparklePositions(generateSparklePositions());
    setResult(data);
    setShowCard(false);

    // Show card after brief delay
    animationTimeoutRef.current = setTimeout(() => {
      setShowCard(true);

      // Hide after display
      animationTimeoutRef.current = setTimeout(() => {
        setShowCard(false);
        animationTimeoutRef.current = setTimeout(() => {
          setResult(null);
        }, 500);
      }, 6000);
    }, 100);
  }, [checkImageAspectRatio]);

  // Connect to Supabase Realtime for real-time events
  useEffect(() => {
    const cleanup = subscribeToGachaResults(streamerId, (payload) => {
      if (payload.type === 'gacha' && payload.card) {
        displayResult({
          card: payload.card as unknown as Card,
          userTwitchUsername: payload.userTwitchUsername,
        });
      }
    }, {
      onError: (error) => {
        if (error.isExpected) {
          setConnectionStatus('disconnected');
          setErrorMessage(null);
        } else {
          setConnectionStatus('error');
          setErrorMessage(error.message);
        }
      },
      onSuccess: () => {
        setConnectionStatus('connected');
        if (connectionTimeoutRef.current) {
          clearTimeout(connectionTimeoutRef.current);
          connectionTimeoutRef.current = null;
        }
      },
    });

    connectionTimeoutRef.current = setTimeout(() => {
      if (connectionStatusRef.current === 'connecting') {
        setConnectionStatus('error');
        setErrorMessage('Connection timeout');
      }
    }, 10000);

    cleanupRef.current = cleanup;

    return () => {
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
  }, [streamerId, displayResult]);

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
        displayResult(data);
      }
    } catch (error) {
      logger.error("Demo gacha error:", error);
    }
  }, [displayResult, streamerId]);

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
        {/* Connection status indicator */}
        {connectionStatus === 'connecting' && (
          <div className="fixed top-4 right-4 rounded bg-blue-600 px-4 py-2 text-sm text-white">
            接続中...
          </div>
        )}
        {connectionStatus === 'error' && errorMessage && (
          <div className="fixed top-4 right-4 max-w-sm rounded bg-red-600 p-4 text-sm text-white">
            <div className="mb-2 font-bold">接続エラー</div>
            <div>{errorMessage}</div>
          </div>
        )}
      </div>
    );
  }

  const rarityColor = RARITY_GRADIENT_COLORS[result.card.rarity];
  const rarityGlow = RARITY_GLOW[result.card.rarity];
  const rarityInfo = getRarityInfo(result.card.rarity);

  // 画像のみ表示モードかどうかを判定
  // imageOnlyが有効、またはautoPortraitが有効で縦長画像の場合
  const shouldShowImageOnly = options.imageOnly || (options.autoPortrait && isPortraitImage);

  // エフェクトを表示するかどうか（オプションで無効化されていない場合のみ）
  const shouldShowEffects = options.effects && result.card.rarity === "legendary";

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
          <div className="relative">
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
            {/* Sparkle Effects for Legendary (if enabled) */}
            {shouldShowEffects && (
              <div className="pointer-events-none absolute inset-0">
                {sparklePositions.map((pos, i) => (
                  <div
                    key={i}
                    className="absolute animate-ping"
                    style={pos}
                  >
                    ✨
                  </div>
                ))}
              </div>
            )}
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

            {/* Sparkle Effects for Legendary (if enabled) */}
            {shouldShowEffects && (
              <div className="pointer-events-none absolute inset-0">
                {sparklePositions.map((pos, i) => (
                  <div
                    key={i}
                    className="absolute animate-ping"
                    style={pos}
                  >
                    ✨
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
