"use client";

import { useState, useRef } from "react";
import Image from "next/image";
import type { Card, Rarity } from "@/types/database";
import { RARITIES, UI_STRINGS, UPLOAD_CONFIG } from "@/lib/constants";
import { logger } from "@/lib/logger";
import { validateUpload, getUploadErrorMessage } from "@/lib/upload-validation";

interface CardManagerProps {
  streamerId: string;
  initialCards: Card[];
}

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
  const [uploadError, setUploadError] = useState<string | null>(null);

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
    setUploadError(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    setUploadError(null);
    if (file) {
      const validation = validateUpload(file);
      if (!validation.valid) {
        setUploadError(getUploadErrorMessage(validation.error!));
      }
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
        
        const validation = validateUpload(file);
        if (!validation.valid) {
          setUploadError(getUploadErrorMessage(validation.error!));
          setSaving(false);
          return;
        }

        const formDataUpload = new FormData();
        formDataUpload.append("file", file);

        const uploadResponse = await fetch("/api/upload", {
          method: "POST",
          body: formDataUpload,
        });

        if (!uploadResponse.ok) {
          if (uploadResponse.status === 429) {
            const errorData = await uploadResponse.json();
            setUploadError(errorData.error || UI_STRINGS.CARD_MANAGER.MESSAGES.RATE_LIMIT);
            setSaving(false);
            return;
          }
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
      } else if (response.status === 429) {
        const errorData = await response.json();
        setUploadError(errorData.error || UI_STRINGS.CARD_MANAGER.MESSAGES.RATE_LIMIT);
      }
    } catch (error) {
      logger.error("Failed to save card:", error);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (cardId: string) => {
    if (!confirm(UI_STRINGS.CARD_MANAGER.CONFIRMATIONS.DELETE_CARD)) return;

    const originalCards = cards;
    try {
      // Optimistic update: remove from UI immediately
      setCards(cards.filter((c) => c.id !== cardId));

const response = await fetch(`/api/cards/${cardId}`, {
          method: "DELETE",
          credentials: "include",
        });

      if (!response.ok) {
        if (response.status === 429) {
          const errorData = await response.json().catch(() => ({ error: "Unknown error" }));
          const errorMessage = errorData.error || UI_STRINGS.CARD_MANAGER.MESSAGES.RATE_LIMIT;
          alert(UI_STRINGS.CARD_MANAGER.MESSAGES.OPERATION_FAILED(errorMessage));
          logger.error("Rate limit exceeded:", errorData);
        } else {
          setCards(originalCards);
          const errorData = await response.json().catch(() => ({ error: "Unknown error" }));
          const errorMessage = errorData.error || UI_STRINGS.CARD_MANAGER.MESSAGES.DELETE_FAILED;
          alert(`${UI_STRINGS.CARD_MANAGER.MESSAGES.DELETE_FAILED_PREFIX} ${errorMessage}`);
          logger.error("Delete failed:", errorData);
        }
      }
      // Success: no alert needed as optimistic update already provides feedback
    } catch (error) {
      // Revert on network error
      setCards(originalCards);
      logger.error("Failed to delete card:", error);
      alert(UI_STRINGS.CARD_MANAGER.MESSAGES.NETWORK_ERROR_DELETE);
    }
  };

  const getRarityInfo = (rarity: Rarity) =>
    RARITIES.find((r) => r.value === rarity) || RARITIES[0];

  return (
    <div className="rounded-xl bg-gray-800 p-6">
      <div className="mb-6 flex items-center justify-between">
        <h2 className="text-xl font-semibold text-white">{UI_STRINGS.CARD_MANAGER.TITLE}</h2>
        <button
          onClick={() => setShowForm(true)}
          className="rounded-lg bg-purple-600 px-4 py-2 text-white hover:bg-purple-700"
        >
          {UI_STRINGS.CARD_MANAGER.ADD_NEW_CARD}
        </button>
      </div>

      {/* Card Form */}
      {showForm && (
        <form
          onSubmit={handleSubmit}
          className="mb-6 rounded-lg bg-gray-700 p-6"
        >
          <h3 className="mb-4 text-lg font-medium text-white">
            {editingCard ? UI_STRINGS.CARD_MANAGER.EDIT_CARD : UI_STRINGS.CARD_MANAGER.NEW_CARD}
          </h3>
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <label className="mb-1 block text-sm text-gray-300">
                {UI_STRINGS.CARD_MANAGER.FORM_LABELS.NAME} *
              </label>
              <input
                type="text"
                name="name"
                required
                placeholder={UI_STRINGS.CARD_MANAGER.FORM_LABELS.NAME_PLACEHOLDER}
                value={formData.name}
                onChange={(e) =>
                  setFormData({ ...formData, name: e.target.value })
                }
                className="w-full rounded-lg bg-gray-600 px-4 py-2 text-white"
              />
            </div>
              <div>
              <label className="mb-1 block text-sm text-gray-300">
                {UI_STRINGS.CARD_MANAGER.FORM_LABELS.IMAGE}
              </label>
              <div className="space-y-2">
                <input
                  type="file"
                  name="image"
                  accept="image/*"
                  ref={fileInputRef}
                  onChange={handleFileChange}
                  className="w-full text-sm text-gray-400 file:mr-4 file:rounded-lg file:border-0 file:bg-purple-600 file:px-4 file:py-2 file:text-sm file:font-semibold file:text-white hover:file:bg-purple-700"
                />
                {uploadError && (
                  <p className="text-sm text-red-400">{uploadError}</p>
                )}
                <p className="text-xs text-gray-500">
                  {UI_STRINGS.CARD_MANAGER.FILE_UPLOAD.FORMATS}{UI_STRINGS.CARD_MANAGER.FILE_UPLOAD.MAX_SIZE((UPLOAD_CONFIG.MAX_FILE_SIZE / (1024 * 1024)).toFixed(1) + 'MB')}
                </p>
                <input
                  type="url"
                  name="imageUrl"
                  placeholder={UI_STRINGS.CARD_MANAGER.FORM_LABELS.IMAGE_URL_PLACEHOLDER}
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
                {UI_STRINGS.CARD_MANAGER.FORM_LABELS.RARITY}
              </label>
              <select
                name="rarity"
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
                {UI_STRINGS.CARD_MANAGER.FORM_LABELS.DROP_RATE} ({(formData.dropRate * 100).toFixed(1)}%)
              </label>
              <input
                type="range"
                name="dropRate"
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
              <label className="mb-1 block text-sm text-gray-300">{UI_STRINGS.CARD_MANAGER.FORM_LABELS.DESCRIPTION}</label>
              <textarea
                name="description"
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
              {saving ? UI_STRINGS.CARD_MANAGER.BUTTONS.SAVE : editingCard ? UI_STRINGS.CARD_MANAGER.BUTTONS.UPDATE : UI_STRINGS.CARD_MANAGER.BUTTONS.ADD}
            </button>
            <button
              type="button"
              onClick={resetForm}
              className="rounded-lg border border-gray-600 px-6 py-2 text-gray-300 hover:bg-gray-600"
            >
              {UI_STRINGS.CARD_MANAGER.BUTTONS.CANCEL}
            </button>
          </div>
        </form>
      )}

      {/* Card List */}
      {cards.length === 0 ? (
        <p className="text-center text-gray-400">
          {UI_STRINGS.CARD_MANAGER.MESSAGES.EMPTY_CARDS}
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
          <Image
            src={card.image_url || "/placeholder.png"}
            alt={card.name}
            width={200}
            height={200}
            className="w-full h-48 object-cover rounded mb-2"
          />
                   ) : (
                     <div className="flex h-full items-center justify-center text-gray-500">
                       {UI_STRINGS.CARD_MANAGER.MESSAGES.NO_IMAGE}
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
                     {UI_STRINGS.CARD_MANAGER.MESSAGES.PROBABILITY} {(card.drop_rate * 100).toFixed(1)}%
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
                     {UI_STRINGS.CARD_MANAGER.BUTTONS.EDIT}
                   </button>
                   <button
                     onClick={() => handleDelete(card.id)}
                     className="rounded bg-red-500 px-2 py-1 text-xs text-white hover:bg-red-600"
                   >
                     {UI_STRINGS.CARD_MANAGER.BUTTONS.DELETE}
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
