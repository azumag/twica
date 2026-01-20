"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useParams } from "next/navigation";
import Image from "next/image";
import type { Card } from "@/types/database";
import { logger } from "@/lib/logger";
import { subscribeToGachaResults } from "@/lib/realtime";
import { RARITY_GRADIENT_COLORS, RARITY_GLOW } from "@/lib/constants";

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
  const animationTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const connectionStatusRef = useRef(connectionStatus);
  const connectionTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    connectionStatusRef.current = connectionStatus;
  }, [connectionStatus]);

  // Display gacha result with animation
  const displayResult = useCallback((data: GachaResult) => {
    // Clear any existing animation
    if (animationTimeoutRef.current) {
      clearTimeout(animationTimeoutRef.current);
    }

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
  }, []);

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
  const triggerDemo = useCallback(async () => {
    try {
      // Use demo endpoint which doesn't require authentication
      const response = await fetch("/api/gacha/demo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });

      if (response.ok) {
        const data = await response.json();
        displayResult(data);
      }
      } catch (error) {
        logger.error("Demo gacha error:", error);
      }
  }, [displayResult]);

  // Check URL for demo param
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get("demo") === "true") {
      const timeoutId = setTimeout(() => {
        triggerDemo();
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
        {/* Hidden trigger for demo */}
        <button
          onClick={triggerDemo}
          className="fixed bottom-4 right-4 rounded bg-purple-600 px-4 py-2 text-sm text-white opacity-30 hover:opacity-100"
        >
          Demo
        </button>
      </div>
    );
  }

  const rarityColor = RARITY_GRADIENT_COLORS[result.card.rarity];
  const rarityGlow = RARITY_GLOW[result.card.rarity];

  return (
    <div className="flex h-screen w-screen items-center justify-center bg-transparent">
      <div
        className={`transform transition-all duration-500 ${
          showCard ? "scale-100 opacity-100" : "scale-50 opacity-0"
        }`}
      >
        {/* Card Container */}
        <div
          className={`relative w-80 overflow-hidden rounded-2xl bg-gradient-to-br ${rarityColor} p-1 shadow-2xl ${rarityGlow}`}
        >
          <div className="rounded-xl bg-gray-900 p-4">
            {/* User Info */}
            <div className="mb-3 text-center">
              <span className="text-sm text-gray-400">
                {result.userTwitchUsername} が引いたカード
              </span>
            </div>

            {/* Card Image */}
            <div className="relative aspect-[3/4] overflow-hidden rounded-lg bg-gray-800">
              {result.card.image_url ? (
                <Image
                  src={result.card.image_url}
                  alt={result.card.name}
                  width={300}
                  height={400}
                  className="h-full w-full object-cover"
                />
              ) : (
                <div className="flex h-full items-center justify-center">
                  <span className="text-6xl">🎴</span>
                </div>
              )}

              {/* Rarity Badge */}
              <div
                className={`absolute right-2 top-2 rounded-full bg-gradient-to-r ${rarityColor} px-3 py-1 text-xs font-bold uppercase text-white shadow-lg`}
              >
                {result.card.rarity}
              </div>
            </div>

            {/* Card Info */}
            <div className="mt-4 text-center">
              <h2 className="text-2xl font-bold text-white">
                {result.card.name}
              </h2>
              {result.card.description && (
                <p className="mt-2 text-sm text-gray-400">
                  {result.card.description}
                </p>
              )}
            </div>
          </div>
        </div>

        {/* Sparkle Effects for Legendary */}
        {result.card.rarity === "legendary" && (
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
    </div>
  );
}
