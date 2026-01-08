"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import type { Card } from "@/types/database";

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
  const [isAnimating, setIsAnimating] = useState(false);
  const [showCard, setShowCard] = useState(false);
  const [sparklePositions, setSparklePositions] = useState<SparklePosition[]>([]);

  // Demo function for testing
  const triggerDemo = useCallback(async () => {
    if (isAnimating) return;

    setIsAnimating(true);
    setShowCard(false);

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
        // Generate sparkle positions when we get a result
        setSparklePositions(generateSparklePositions());
        setResult(data);

        // Animation timing
        setTimeout(() => {
          setShowCard(true);
        }, 1000);

        // Hide after display
        setTimeout(() => {
          setShowCard(false);
          setTimeout(() => {
            setIsAnimating(false);
            setResult(null);
          }, 500);
        }, 6000);
      }
    } catch (error) {
      console.error("Demo gacha error:", error);
      setIsAnimating(false);
    }
  }, [streamerId, isAnimating]);

  // Listen for gacha events via polling or websocket
  // For MVP, we'll use a simple approach with URL params for manual trigger
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.data.type === "gacha" && event.data.streamerId === streamerId) {
        triggerDemo();
      }
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [streamerId, triggerDemo]);

  // Check URL for demo param - use setTimeout to avoid triggering during render
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get("demo") === "true") {
      const timeoutId = setTimeout(() => {
        triggerDemo();
      }, 0);
      return () => clearTimeout(timeoutId);
    }
  }, [triggerDemo]);

  if (!result) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-transparent">
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
                <img
                  src={result.card.image_url}
                  alt={result.card.name}
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
