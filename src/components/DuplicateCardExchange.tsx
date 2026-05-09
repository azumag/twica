"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { Rarity } from "@/types/database";

type DuplicateExchangeCard = {
  id: string;
  name: string;
  rarity: Rarity;
  count: number;
  collectionNumber?: number;
  stoneValue: number;
};

interface DuplicateCardExchangeProps {
  balance: number;
  cards: DuplicateExchangeCard[];
  translations: {
    title: string;
    balance: string;
    empty: string;
    description: string;
    exchange: string;
    exchanging: string;
    cardNumberTemplate: string;
    duplicateCountTemplate: string;
    stoneValueTemplate: string;
    successTemplate: string;
    errorFallback: string;
  };
}

export default function DuplicateCardExchange({
  balance,
  cards,
  translations,
}: DuplicateCardExchangeProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [activeCardId, setActiveCardId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const totalAvailableStones = useMemo(
    () => cards.reduce((sum, card) => sum + (card.count - 1) * card.stoneValue, 0),
    [cards]
  );

  const exchangeCard = async (card: DuplicateExchangeCard) => {
    setActiveCardId(card.id);
    setMessage(null);
    setError(null);

    try {
      const response = await fetch("/api/card-stones/exchange", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cardId: card.id }),
      });
      const result = await response.json().catch(() => null) as
        | { stonesGained?: number; error?: string }
        | null;

      if (!response.ok) {
        setError(result?.error || translations.errorFallback);
        return;
      }

      setMessage(
        translations.successTemplate.replace(
          "{count}",
          String(result?.stonesGained || card.stoneValue)
        )
      );
      startTransition(() => router.refresh());
    } catch {
      setError(translations.errorFallback);
    } finally {
      setActiveCardId(null);
    }
  };

  return (
    <section className="mb-6 rounded-xl border border-gray-700 bg-gray-800 p-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold text-white">{translations.title}</h2>
          <p className="mt-1 text-sm text-gray-400">{translations.description}</p>
        </div>
        <div className="text-sm font-medium text-purple-200">
          {translations.balance.replace("{count}", String(balance))}
        </div>
      </div>

      {cards.length === 0 ? (
        <p className="mt-4 text-sm text-gray-400">{translations.empty}</p>
      ) : (
        <div className="mt-4 grid gap-2">
          {cards.map((card) => {
            const disabled = isPending || activeCardId !== null;
            const isActive = activeCardId === card.id;
            return (
              <div
                key={card.id}
                className="flex flex-col gap-3 rounded-lg border border-gray-700 bg-gray-900/60 p-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    {card.collectionNumber ? (
                      <span className="rounded bg-gray-700 px-2 py-0.5 text-xs text-gray-300">
                        {translations.cardNumberTemplate.replace("{number}", String(card.collectionNumber))}
                      </span>
                    ) : null}
                    <span className="truncate font-medium text-white">{card.name}</span>
                  </div>
                  <div className="mt-1 text-sm text-gray-400">
                    {translations.duplicateCountTemplate.replace("{count}", String(card.count - 1))}
                    <span className="mx-2 text-gray-600">/</span>
                    {translations.stoneValueTemplate.replace("{count}", String(card.stoneValue))}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => exchangeCard(card)}
                  disabled={disabled}
                  className="rounded-lg bg-purple-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-purple-500 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {isActive ? translations.exchanging : translations.exchange}
                </button>
              </div>
            );
          })}
        </div>
      )}

      {totalAvailableStones > 0 ? (
        <p className="mt-3 text-xs text-gray-500">
          {translations.stoneValueTemplate.replace("{count}", String(totalAvailableStones))}
        </p>
      ) : null}
      {message ? <p className="mt-3 text-sm text-green-300">{message}</p> : null}
      {error ? <p className="mt-3 text-sm text-red-300">{error}</p> : null}
    </section>
  );
}
