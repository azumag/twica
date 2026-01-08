"use client";

import { useState, useRef } from "react";
import type { Card, Rarity } from "@/types/database";
import { upload } from "@vercel/blob/client";

interface CardManagerProps {
  streamerId: string;
  initialCards: Card[];
}

const RARITIES: { value: Rarity; label: string; color: string }[] = [
  { value: "common", label: "コモン", color: "bg-gray-500" },
  { value: "rare", label: "レア", color: "bg-blue-500" },
  { value: "epic", label: "エピック", color: "bg-purple-500" },
  { value: "legendary", label: "レジェンダリー", color: "bg-yellow-500" },
];

export default function CardManager({
  streamerId,
  initialCards,
}: CardManagerProps) {
  const [cards, setCards] = useState<Card[]>(initialCards);
  const [showForm, setShowForm] = useState(false);
  const [editingCard, setEditingCard] = useState<Card | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [formData, setFormData] = useState({
    name: "",
    description: "",
    imageUrl: "",
    rarity: "common" as Rarity,
    dropRate: 0.25,
  });
  const [saving, setSaving] = useState(false);

  const resetForm = () => {
    setFormData({
      name: "",
      description: "",
      imageUrl: "",
      rarity: "common",
      dropRate: 0.25,
    });
    setEditingCard(null);
    setShowForm(false);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const handleEdit = (card: Card) => {
    setEditingCard(card);
    setFormData({
      name: card.name,
      description: card.description || "",
      imageUrl: card.image_url || "",
      rarity: card.rarity,
      dropRate: card.drop_rate,
    });
    setShowForm(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);

    try {
      let finalImageUrl = formData.imageUrl;

      // Handle file upload if a file is selected
      if (fileInputRef.current?.files?.[0]) {
        const file = fileInputRef.current.files[0];
        const formDataUpload = new FormData();
        formDataUpload.append("file", file);

        const uploadResponse = await fetch("/api/upload", {
          method: "POST",
          body: formDataUpload,
        });

        if (!uploadResponse.ok) {
          throw new Error("Failed to upload image");
        }

        const blob = await uploadResponse.json();
        finalImageUrl = blob.url;
      }
      const endpoint = editingCard
        ? `/api/cards/${editingCard.id}`
        : "/api/cards";
      const method = editingCard ? "PUT" : "POST";

      const response = await fetch(endpoint, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          streamerId,
          name: formData.name,
          description: formData.description,
          imageUrl: finalImageUrl,
          rarity: formData.rarity,
          dropRate: formData.dropRate,
        }),
      });

      if (response.ok) {
        const updatedCard = await response.json();
        if (editingCard) {
          setCards(cards.map((c) => (c.id === editingCard.id ? updatedCard : c)));
        } else {
          setCards([updatedCard, ...cards]);
        }
        resetForm();
      }
    } catch (error) {
      console.error("Failed to save card:", error);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (cardId: string) => {
    if (!confirm("このカードを削除しますか？")) return;

    try {
      const response = await fetch(`/api/cards/${cardId}`, {
        method: "DELETE",
      });

      if (response.ok) {
        setCards(cards.filter((c) => c.id !== cardId));
      }
    } catch (error) {
      console.error("Failed to delete card:", error);
    }
  };

  const getRarityInfo = (rarity: Rarity) =>
    RARITIES.find((r) => r.value === rarity) || RARITIES[0];

  return (
    <div className="rounded-xl bg-gray-800 p-6">
      <div className="mb-6 flex items-center justify-between">
        <h2 className="text-xl font-semibold text-white">カード管理</h2>
        <button
          onClick={() => setShowForm(true)}
          className="rounded-lg bg-purple-600 px-4 py-2 text-white hover:bg-purple-700"
        >
          新規カード追加
        </button>
      </div>

      {/* Card Form */}
      {showForm && (
        <form
          onSubmit={handleSubmit}
          className="mb-6 rounded-lg bg-gray-700 p-6"
        >
          <h3 className="mb-4 text-lg font-medium text-white">
            {editingCard ? "カードを編集" : "新規カード"}
          </h3>
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <label className="mb-1 block text-sm text-gray-300">
                カード名 *
              </label>
              <input
                type="text"
                required
                value={formData.name}
                onChange={(e) =>
                  setFormData({ ...formData, name: e.target.value })
                }
                className="w-full rounded-lg bg-gray-600 px-4 py-2 text-white"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm text-gray-300">
                画像 (ファイルまたはURL)
              </label>
              <div className="space-y-2">
                <input
                  type="file"
                  accept="image/*"
                  ref={fileInputRef}
                  className="w-full text-sm text-gray-400 file:mr-4 file:rounded-lg file:border-0 file:bg-purple-600 file:px-4 file:py-2 file:text-sm file:font-semibold file:text-white hover:file:bg-purple-700"
                />
                <input
                  type="url"
                  placeholder="または画像URLを入力"
                  value={formData.imageUrl}
                  onChange={(e) =>
                    setFormData({ ...formData, imageUrl: e.target.value })
                  }
                  className="w-full rounded-lg bg-gray-600 px-4 py-2 text-white"
                />
              </div>
            </div>
            <div>
              <label className="mb-1 block text-sm text-gray-300">
                レアリティ
              </label>
              <select
                value={formData.rarity}
                onChange={(e) =>
                  setFormData({ ...formData, rarity: e.target.value as Rarity })
                }
                className="w-full rounded-lg bg-gray-600 px-4 py-2 text-white"
              >
                {RARITIES.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-sm text-gray-300">
                出現確率 ({(formData.dropRate * 100).toFixed(1)}%)
              </label>
              <input
                type="range"
                min="0"
                max="1"
                step="0.01"
                value={formData.dropRate}
                onChange={(e) =>
                  setFormData({
                    ...formData,
                    dropRate: parseFloat(e.target.value),
                  })
                }
                className="w-full"
              />
            </div>
            <div className="md:col-span-2">
              <label className="mb-1 block text-sm text-gray-300">説明</label>
              <textarea
                value={formData.description}
                onChange={(e) =>
                  setFormData({ ...formData, description: e.target.value })
                }
                rows={3}
                className="w-full rounded-lg bg-gray-600 px-4 py-2 text-white"
              />
            </div>
          </div>
          <div className="mt-4 flex gap-4">
            <button
              type="submit"
              disabled={saving}
              className="rounded-lg bg-purple-600 px-6 py-2 text-white hover:bg-purple-700 disabled:opacity-50"
            >
              {saving ? "保存中..." : editingCard ? "更新" : "追加"}
            </button>
            <button
              type="button"
              onClick={resetForm}
              className="rounded-lg border border-gray-600 px-6 py-2 text-gray-300 hover:bg-gray-600"
            >
              キャンセル
            </button>
          </div>
        </form>
      )}

      {/* Card List */}
      {cards.length === 0 ? (
        <p className="text-center text-gray-400">
          まだカードがありません。「新規カード追加」から始めましょう。
        </p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {cards.map((card) => {
            const rarityInfo = getRarityInfo(card.rarity);
            return (
              <div
                key={card.id}
                className="group relative overflow-hidden rounded-lg bg-gray-700"
              >
                <div className="aspect-[3/4] bg-gray-600">
                  {card.image_url ? (
                    <img
                      src={card.image_url}
                      alt={card.name}
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <div className="flex h-full items-center justify-center text-gray-500">
                      No Image
                    </div>
                  )}
                </div>
                <div className="p-4">
                  <div className="mb-2 flex items-center justify-between">
                    <h3 className="font-semibold text-white">{card.name}</h3>
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs text-white ${rarityInfo.color}`}
                    >
                      {rarityInfo.label}
                    </span>
                  </div>
                  <p className="mb-2 text-sm text-gray-400">
                    確率: {(card.drop_rate * 100).toFixed(1)}%
                  </p>
                  {card.description && (
                    <p className="text-sm text-gray-300 line-clamp-2">
                      {card.description}
                    </p>
                  )}
                </div>
                <div className="absolute right-2 top-2 flex gap-2 opacity-0 transition-opacity group-hover:opacity-100">
                  <button
                    onClick={() => handleEdit(card)}
                    className="rounded bg-blue-500 px-2 py-1 text-xs text-white hover:bg-blue-600"
                  >
                    編集
                  </button>
                  <button
                    onClick={() => handleDelete(card.id)}
                    className="rounded bg-red-500 px-2 py-1 text-xs text-white hover:bg-red-600"
                  >
                    削除
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
