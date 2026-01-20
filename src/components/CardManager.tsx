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
  const [deletingImage, setDeletingImage] = useState(false);
  // Separate state for confirmed image URL (only update on blur)
  // プレビュー表示用の確定済み画像URL（フォーカスが外れた時のみ更新）
  const [confirmedImageUrl, setConfirmedImageUrl] = useState("");
  // Track if user has interacted with image field (to keep URL input visible)
  // ユーザーが画像フィールドを操作したかどうか（URL入力欄を表示し続けるため）
  const [userModifiedImage, setUserModifiedImage] = useState(true);

  // Delete image from Vercel Blob
  // Vercel Blobから画像を削除
  const deleteImage = async (url: string): Promise<boolean> => {
    try {
      const response = await fetch("/api/upload/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ url }),
      });
      return response.ok;
    } catch {
      return false;
    }
  };

  // Handle image removal
  // 画像削除処理
  const handleRemoveImage = async () => {
    if (!confirmedImageUrl) return;

    // Only delete from Blob if it's a Vercel Blob URL
    // Vercel BlobのURLの場合のみBlobから削除
    const isBlobUrl = confirmedImageUrl.includes("blob.vercel-storage.com") ||
                      confirmedImageUrl.includes("public.blob.vercel-storage.com");

    if (isBlobUrl) {
      setDeletingImage(true);
      const deleted = await deleteImage(confirmedImageUrl);
      setDeletingImage(false);

      if (!deleted) {
        setUploadError("画像の削除に失敗しました");
        return;
      }
    }

    setFormData({ ...formData, imageUrl: "" });
    setConfirmedImageUrl("");
    setUserModifiedImage(true);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const resetForm = () => {
    setFormData({
      name: "",
      description: "",
      imageUrl: "",
      rarity: "common",
      dropRate: 0.25,
    });
    setConfirmedImageUrl("");
    setUserModifiedImage(true);
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
    setConfirmedImageUrl(card.image_url || "");
    // Hide URL input initially only when editing card with existing image
    // 既存画像がある場合のみ、URL入力欄を初期状態で非表示
    setUserModifiedImage(!card.image_url);
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
          credentials: "include",
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
        credentials: "include",
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
      } else {
        // Handle other errors (403, 400, 401, etc.)
        const errorData = await response.json().catch(() => ({ error: "Unknown error" }));
        setUploadError(errorData.error || `エラーが発生しました (${response.status})`);
        logger.error("Failed to save card:", errorData);
      }
    } catch (error) {
      logger.error("Failed to save card:", error);
    } finally {
      setSaving(false);
    }
  };

  // 配布一時停止/再開のトグル
  const handleToggleActive = async (card: Card) => {
    const newIsActive = !card.is_active;
    const originalCards = cards;

    try {
      // Optimistic update
      setCards(cards.map((c) => c.id === card.id ? { ...c, is_active: newIsActive } : c));

      const response = await fetch(`/api/cards/${card.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ isActive: newIsActive }),
      });

      if (!response.ok) {
        // Revert on error
        setCards(originalCards);
        const errorData = await response.json().catch(() => ({ error: "Unknown error" }));
        alert(`操作に失敗しました: ${errorData.error}`);
        logger.error("Toggle active failed:", errorData);
      }
    } catch (error) {
      setCards(originalCards);
      logger.error("Failed to toggle card active:", error);
      alert("ネットワークエラーが発生しました");
    }
  };

  // 全体削除（手持ちからも削除）
  const handleDelete = async (cardId: string) => {
    if (!confirm("このカードを完全に削除しますか？\n\n⚠️ 既にこのカードを持っているユーザーの手持ちからも削除されます。")) return;

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
                {/* Error message - always visible when there's an error */}
                {/* エラーメッセージ - エラーがある場合は常に表示 */}
                {uploadError && (
                  <p className="text-sm text-red-400 bg-red-900/30 px-3 py-2 rounded">{uploadError}</p>
                )}

                {/* Show current image preview and delete button when confirmed URL exists */}
                {/* 確定済みURLがある場合は画像プレビューと削除ボタンを表示 */}
                {confirmedImageUrl && (
                  <div className="flex items-center gap-3 rounded-lg bg-gray-600 p-3">
                    <Image
                      src={confirmedImageUrl}
                      alt="現在の画像"
                      width={60}
                      height={60}
                      className="rounded object-cover"
                    />
                    <div className="flex-1">
                      <p className="text-sm text-gray-300">現在の画像</p>
                      <p className="text-xs text-gray-500 truncate max-w-[200px]">
                        {confirmedImageUrl.split('/').pop()}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={handleRemoveImage}
                      disabled={deletingImage}
                      className="rounded bg-red-500 px-3 py-1 text-sm text-white hover:bg-red-600 disabled:opacity-50"
                    >
                      {deletingImage ? "削除中..." : "画像を削除"}
                    </button>
                  </div>
                )}

                {/* Show file input when no confirmed image or user has modified the field */}
                {/* 確定済み画像がないか、ユーザーが操作した場合にファイル入力を表示 */}
                {(!confirmedImageUrl || userModifiedImage) && (
                  <>
                    <input
                      type="file"
                      name="image"
                      accept="image/*"
                      ref={fileInputRef}
                      onChange={handleFileChange}
                      className="w-full text-sm text-gray-400 file:mr-4 file:rounded-lg file:border-0 file:bg-purple-600 file:px-4 file:py-2 file:text-sm file:font-semibold file:text-white hover:file:bg-purple-700"
                    />
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
                      onBlur={() => {
                        // Confirm URL on blur and mark as user modified
                        // フォーカスが外れた時にURLを確定し、ユーザー操作フラグを設定
                        if (formData.imageUrl) {
                          setConfirmedImageUrl(formData.imageUrl);
                        }
                        setUserModifiedImage(true);
                      }}
                      className="w-full rounded-lg bg-gray-600 px-4 py-2 text-white"
                    />
                  </>
                )}
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
            const isPaused = !card.is_active;
            return (
              <div
                key={card.id}
                className={`group relative overflow-hidden rounded-lg bg-gray-700 ${isPaused ? 'opacity-60' : ''}`}
              >
                {/* 一時停止中バッジ */}
                {isPaused && (
                  <div className="absolute top-0 left-0 right-0 bg-yellow-600 text-white text-xs text-center py-1 z-10">
                    配布停止中
                  </div>
                )}
                {/* 名前とレアリティを一番上に配置 */}
                <div className={`p-3 pb-2 ${isPaused ? 'pt-8' : ''}`}>
                  <div className="flex items-center justify-between">
                    <h3 className="font-semibold text-white truncate">{card.name}</h3>
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs text-white shrink-0 ml-2 ${rarityInfo.color}`}
                    >
                      {rarityInfo.label}
                    </span>
                  </div>
                </div>
                {/* 正方形画像（トリミング） */}
                <div className="aspect-square bg-gray-600">
                  {card.image_url ? (
                    <Image
                      src={card.image_url}
                      alt={card.name}
                      width={300}
                      height={300}
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <div className="flex h-full items-center justify-center text-gray-500">
                      {UI_STRINGS.CARD_MANAGER.MESSAGES.NO_IMAGE}
                    </div>
                  )}
                </div>
                {/* 説明は画像の下 */}
                {card.description && (
                  <div className="p-3 pt-2">
                    <p className="text-sm text-gray-300 line-clamp-2">
                      {card.description}
                    </p>
                  </div>
                )}
                {/* 操作ボタン */}
                <div className="p-3 pt-0 flex gap-2 flex-wrap">
                  {/* 配布停止/再開ボタン */}
                  <button
                    onClick={() => handleToggleActive(card)}
                    className={`rounded px-2 py-1 text-xs text-white ${
                      isPaused
                        ? 'bg-green-600 hover:bg-green-700'
                        : 'bg-yellow-600 hover:bg-yellow-700'
                    }`}
                  >
                    {isPaused ? '配布再開' : '配布停止'}
                  </button>
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
                    完全削除
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
