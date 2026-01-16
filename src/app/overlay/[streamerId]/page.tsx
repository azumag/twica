"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useParams } from "next/navigation";
import Image from "next/image";
import type { Card } from "@/types/database";
import { logger } from "@/lib/logger";

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

const RARITY_COLORS = {
  common: "from-gray-400 to-gray-600",
  rare: "from-blue-400 to-blue-600",
  epic: "from-purple-400 to-purple-600",
  legendary: "from-yellow-400 to-orange-500",
};

const RARITY_GLOW = {
  common: "shadow-gray-500/50",
  rare: "shadow-blue-500/50",
  epic: "shadow-purple-500/50",
  legendary: "shadow-yellow-500/50",
};

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
  const [connected, setConnected] = useState(false);
  const eventSourceRef = useRef<EventSource | null>(null);
  const animationTimeoutRef = useRef<NodeJS.Timeout | null>(null);

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

  // Connect to SSE for real-time events
  useEffect(() => {
    const connectSSE = () => {
      const eventSource = new EventSource(`/api/events/${streamerId}`);
      eventSourceRef.current = eventSource;

      eventSource.onopen = () => {
        setConnected(true);
      };

      eventSource.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === "gacha" && data.card) {
            displayResult({
              card: data.card,
              userTwitchUsername: data.userTwitchUsername,
            });
          }
        } catch (error) {
          logger.error("SSE parse error:", error);
        }
      };

      eventSource.onerror = (error) => {
        logger.error("SSE error:", error);
        setConnected(false);
        eventSource.close();

        // Reconnect after delay
        setTimeout(connectSSE, 3000);
      };
    };

    connectSSE();

    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }
      if (animationTimeoutRef.current) {
        clearTimeout(animationTimeoutRef.current);
      }
    };
  }, [streamerId, displayResult]);

  // Demo function for testing
  const triggerDemo = useCallback(async () => {
    try {
      const response = await fetch("/api/gacha", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          streamerId,
          userTwitchId: "demo_user",
          userTwitchUsername: "DemoUser",
        }),
      });

      if (response.ok) {
        const data = await response.json();
        displayResult(data);
      }
      } catch (error) {
        logger.error("Demo gacha error:", error);
      }
  }, [streamerId, displayResult]);

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
        <div className="fixed left-4 top-4 flex items-center gap-2 rounded bg-black/50 px-3 py-1 text-xs text-white opacity-50">
          <div
            className={`h-2 w-2 rounded-full ${
              connected ? "bg-green-500" : "bg-red-500"
            }`}
          />
          {connected ? "接続中" : "再接続中..."}
        </div>

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

  const rarityColor = RARITY_COLORS[result.card.rarity];
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
