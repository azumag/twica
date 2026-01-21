"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Image from "next/image";
import type { Card, Rarity } from "@/types/database";
import { RARITIES, UI_STRINGS, UPLOAD_CONFIG } from "@/lib/constants";
import { logger } from "@/lib/logger";
import { validateUpload, getUploadErrorMessage } from "@/lib/upload-validation";
import ImageCropper from "./ImageCropper";
import CardViewToggle, { type ViewMode } from "./CardViewToggle";
import CardList from "./CardList";
import Pagination from "./Pagination";

interface StorageStatus {
  userUsage: number;
  globalUsage: number;
  userUsageFormatted: string;
  globalUsageFormatted: string;
  userLimitFormatted: string;
  globalLimitFormatted: string;
  userLimitReached: boolean;
  globalLimitReached: boolean;
  uploadDisabled: boolean;
  message: string | null;
}

/**
 * Twitch emote data structure
 * Twitchエモートのデータ構造
 */
interface TwitchEmote {
  id: string;
  name: string;
  imageUrl: string;
  tier: string;
  emoteType: string;
}


/**
 * Server-side pagination info
 * サーバーサイドページング情報
 */
interface ServerPagination {
  currentPage: number;
  totalPages: number;
  total: number;
  perPage: number;
}

interface CardManagerProps {
  streamerId: string;
  initialCards: Card[];
  // Initial view mode (default: 'thumbnail')
  // 初期表示モード（デフォルト: 'thumbnail'）
  viewMode?: ViewMode;
  // Whether to show view toggle buttons (default: false)
  // 表示切り替えボタンを表示するかどうか（デフォルト: false）
  showViewToggle?: boolean;
  // Whether to enable pagination (default: false)
  // ページネーションを有効にするかどうか（デフォルト: false）
  enablePagination?: boolean;
  // Number of cards per page for client-side pagination (default: 12)
  // クライアントサイドページング用の1ページあたりのカード数（デフォルト: 12）
  cardsPerPage?: number;
  // Maximum number of cards to display (for preview mode)
  // 表示するカードの最大数（プレビューモード用）
  maxCards?: number;
  // Server-side pagination info (if provided, uses server pagination)
  // サーバーサイドページング情報（指定された場合はサーバーページングを使用）
  serverPagination?: ServerPagination;
}

export default function CardManager({
  streamerId,
  initialCards,
  viewMode: initialViewMode = "thumbnail",
  showViewToggle = false,
  enablePagination = false,
  cardsPerPage = 12,
  maxCards,
  serverPagination,
}: CardManagerProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [cards, setCards] = useState<Card[]>(initialCards);
  // Current view mode state (thumbnail or list)
  // 現在の表示モード状態（サムネイルまたはリスト）
  const [currentViewMode, setCurrentViewMode] = useState<ViewMode>(initialViewMode);
  // Current page for client-side pagination (1-indexed)
  // クライアントサイドページネーション用の現在のページ（1始まり）
  const [currentPage, setCurrentPage] = useState(1);

  /**
   * Handle server-side page change by updating URL
   * URLを更新してサーバーサイドページ変更を処理
   */
  const handleServerPageChange = useCallback((page: number) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set("page", page.toString());
    router.push(`?${params.toString()}`);
  }, [router, searchParams]);
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
  // Modal for drop rate explanation
  // 出現確率説明モーダル
  const [showDropRateInfo, setShowDropRateInfo] = useState(false);
  // Storage status for upload limits
  // アップロード制限用のストレージ状態
  const [storageStatus, setStorageStatus] = useState<StorageStatus | null>(null);
  // Image cropping modal state
  // 画像トリミングモーダルの状態
  const [cropModalOpen, setCropModalOpen] = useState(false);
  // Original file selected for cropping (before crop)
  // トリミング対象として選択されたオリジナルファイル（トリミング前）
  const [selectedFileForCrop, setSelectedFileForCrop] = useState<File | null>(null);
  // Cropped image file ready for upload
  // アップロード準備完了のトリミング済み画像ファイル
  const [croppedFile, setCroppedFile] = useState<File | null>(null);
  // Preview URL for cropped image (managed separately to avoid memory leaks)
  // トリミング済み画像のプレビューURL（メモリリーク防止のため別管理）
  const [croppedPreviewUrl, setCroppedPreviewUrl] = useState<string | null>(null);

  // Emote import modal state
  // エモートインポートモーダルの状態
  const [showEmoteModal, setShowEmoteModal] = useState(false);
  const [emotes, setEmotes] = useState<TwitchEmote[]>([]);
  const [selectedEmotes, setSelectedEmotes] = useState<Set<string>>(new Set());
  const [loadingEmotes, setLoadingEmotes] = useState(false);
  const [emoteError, setEmoteError] = useState<string | null>(null);
  const [creatingCards, setCreatingCards] = useState(false);
  // Default rarity for emote cards
  // エモートカードのデフォルトレアリティ
  const [emoteDefaultRarity, setEmoteDefaultRarity] = useState<Rarity>("common");
  // Default drop rate for emote cards
  // エモートカードのデフォルト出現確率
  const [emoteDefaultDropRate, setEmoteDefaultDropRate] = useState(0.25);

  // Fetch storage status
  // ストレージ状態を取得
  const fetchStorageStatus = useCallback(async () => {
    try {
      const response = await fetch("/api/storage-status", {
        credentials: "include",
      });
      if (response.ok) {
        const status = await response.json();
        setStorageStatus(status);
      }
    } catch (error) {
      logger.error("Failed to fetch storage status:", error);
    }
  }, []);

  useEffect(() => {
    fetchStorageStatus();
  }, [fetchStorageStatus]);

  /**
   * Fetch emotes from Twitch API
   * Twitch APIからエモートを取得
   */
  const fetchEmotes = useCallback(async () => {
    setLoadingEmotes(true);
    setEmoteError(null);
    try {
      const response = await fetch("/api/twitch/emotes", {
        credentials: "include",
      });
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || "エモートの取得に失敗しました");
      }
      const data: TwitchEmote[] = await response.json();
      setEmotes(data);
    } catch (error) {
      logger.error("Failed to fetch emotes:", error);
      setEmoteError(error instanceof Error ? error.message : "エモートの取得に失敗しました");
    } finally {
      setLoadingEmotes(false);
    }
  }, []);

  /**
   * Get emotes that don't already exist as cards (by name comparison)
   * 既存カード名と比較して、まだカードになっていないエモートを取得
   */
  const getAvailableEmotes = useCallback(() => {
    const existingCardNames = new Set(cards.map(c => c.name.toLowerCase()));
    return emotes.filter(emote => !existingCardNames.has(emote.name.toLowerCase()));
  }, [emotes, cards]);

  /**
   * Toggle emote selection
   * エモートの選択をトグル
   */
  const toggleEmoteSelection = (emoteId: string) => {
    setSelectedEmotes(prev => {
      const newSet = new Set(prev);
      if (newSet.has(emoteId)) {
        newSet.delete(emoteId);
      } else {
        newSet.add(emoteId);
      }
      return newSet;
    });
  };

  /**
   * Select all available emotes
   * 利用可能な全エモートを選択
   */
  const selectAllEmotes = () => {
    const availableEmotes = getAvailableEmotes();
    setSelectedEmotes(new Set(availableEmotes.map(e => e.id)));
  };

  /**
   * Deselect all emotes
   * 全エモートの選択を解除
   */
  const deselectAllEmotes = () => {
    setSelectedEmotes(new Set());
  };

  /**
   * Create cards from selected emotes
   * 選択したエモートからカードを作成
   */
  const createCardsFromEmotes = async () => {
    if (selectedEmotes.size === 0) return;

    setCreatingCards(true);
    setEmoteError(null);

    try {
      // Get CSRF token from cookie
      // CookieからCSRFトークンを取得
      const csrfToken = document.cookie
        .split("; ")
        .find(row => row.startsWith("csrf_token="))
        ?.split("=")[1];

      const selectedEmoteData = emotes.filter(e => selectedEmotes.has(e.id));
      const cardsToCreate = selectedEmoteData.map(emote => ({
        name: emote.name,
        imageUrl: emote.imageUrl,
        rarity: emoteDefaultRarity,
        dropRate: emoteDefaultDropRate,
        description: `Twitchエモート: ${emote.name}`,
      }));

      const response = await fetch("/api/cards/batch", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": csrfToken || "",
        },
        credentials: "include",
        body: JSON.stringify({
          streamerId,
          cards: cardsToCreate,
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || "カードの作成に失敗しました");
      }

      const result = await response.json();

      // Add created cards to the list
      // 作成したカードをリストに追加
      if (result.cards) {
        setCards(prev => [...result.cards, ...prev]);
      }

      // Close modal and reset state
      // モーダルを閉じて状態をリセット
      setShowEmoteModal(false);
      setSelectedEmotes(new Set());
    } catch (error) {
      logger.error("Failed to create cards from emotes:", error);
      setEmoteError(error instanceof Error ? error.message : "カードの作成に失敗しました");
    } finally {
      setCreatingCards(false);
    }
  };

  /**
   * Open emote import modal
   * エモートインポートモーダルを開く
   */
  const openEmoteModal = () => {
    setShowEmoteModal(true);
    setSelectedEmotes(new Set());
    setEmoteError(null);
    fetchEmotes();
  };

  // Calculate total weight and actual probability
  // 合計重みと実際の確率を計算
  const calculateActualProbability = (dropRate: number): number => {
    // Get total weight of all active cards (excluding current if editing)
    // 全アクティブカードの合計重み（編集中の場合は現在のカードを除く）
    const otherCardsWeight = cards
      .filter(c => c.is_active && (!editingCard || c.id !== editingCard.id))
      .reduce((sum, c) => sum + c.drop_rate, 0);
    const totalWeight = otherCardsWeight + dropRate;
    if (totalWeight === 0) return 0;
    return (dropRate / totalWeight) * 100;
  };

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
      // Refresh storage status after successful deletion
      // 削除成功後にストレージ状態を更新
      fetchStorageStatus();
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
    // Reset cropping state
    // トリミング状態をリセット
    setCropModalOpen(false);
    setSelectedFileForCrop(null);
    setCroppedFile(null);
    // Clean up preview URL to prevent memory leaks
    // メモリリーク防止のためプレビューURLをクリーンアップ
    if (croppedPreviewUrl) {
      URL.revokeObjectURL(croppedPreviewUrl);
      setCroppedPreviewUrl(null);
    }
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    setUploadError(null);
    if (file) {
      // Only validate file type before cropping (skip size check)
      // Cropped image will be compressed to 400x400 JPEG, so original size doesn't matter
      // トリミング前はファイルタイプのみ検証（サイズチェックはスキップ）
      // トリミング後は400x400 JPEGに圧縮されるため、元のサイズは問題にならない
      const allowedTypes = UPLOAD_CONFIG.ALLOWED_TYPES as readonly string[];
      if (!allowedTypes.includes(file.type)) {
        setUploadError(getUploadErrorMessage("INVALID_FILE_TYPE"));
        return;
      }
      // Open cropping modal instead of direct upload
      // 直接アップロードせずにトリミングモーダルを開く
      setSelectedFileForCrop(file);
      setCropModalOpen(true);
    }
  };

  /**
   * Handles the completion of image cropping
   * 画像トリミング完了時の処理
   * @param croppedBlob - The cropped image as a Blob
   */
  const handleCropComplete = (croppedBlob: Blob) => {
    // Convert Blob to File with a proper filename for upload
    // アップロード用に適切なファイル名でBlobをFileに変換
    const croppedFileName = `cropped-${Date.now()}.jpg`;
    const file = new File([croppedBlob], croppedFileName, { type: "image/jpeg" });
    setCroppedFile(file);
    // Create preview URL for the cropped image
    // トリミング済み画像のプレビューURLを作成
    const previewUrl = URL.createObjectURL(croppedBlob);
    setCroppedPreviewUrl(previewUrl);
    setCropModalOpen(false);
    setSelectedFileForCrop(null);
    // Clear the file input since we now have a cropped file
    // トリミング済みファイルがあるのでファイル入力をクリア
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  /**
   * Handles cancellation of image cropping
   * 画像トリミングのキャンセル処理
   */
  const handleCropCancel = () => {
    setCropModalOpen(false);
    setSelectedFileForCrop(null);
    // Clear the file input
    // ファイル入力をクリア
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

      // Prioritize cropped file over raw file input
      // 生のファイル入力よりトリミング済みファイルを優先
      const fileToUpload = croppedFile || fileInputRef.current?.files?.[0];

      // Handle file upload if a file is selected
      // ファイルが選択されている場合はアップロード処理
      if (fileToUpload) {
        // Skip validation for cropped files (already validated before cropping)
        // トリミング済みファイルはバリデーションをスキップ（トリミング前に検証済み）
        if (!croppedFile) {
          const validation = validateUpload(fileToUpload);
          if (!validation.valid) {
            setUploadError(getUploadErrorMessage(validation.error!));
            setSaving(false);
            return;
          }
        }

        const formDataUpload = new FormData();
        formDataUpload.append("file", fileToUpload);

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
          // Handle storage limit errors (507 Insufficient Storage)
          // ストレージ制限エラーを処理 (507)
          if (uploadResponse.status === 507) {
            const errorData = await uploadResponse.json();
            setUploadError(errorData.error);
            fetchStorageStatus(); // Refresh storage status
            setSaving(false);
            return;
          }
          throw new Error("Failed to upload image");
        }

        const blob = await uploadResponse.json();
        finalImageUrl = blob.url;
        // Refresh storage status after successful upload
        // アップロード成功後にストレージ状態を更新
        fetchStorageStatus();
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
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-xl font-semibold text-white">{UI_STRINGS.CARD_MANAGER.TITLE}</h2>
        <div className="flex gap-2">
          {/* Emote import button */}
          {/* エモートインポートボタン */}
          <button
            onClick={openEmoteModal}
            className="rounded-lg border border-purple-600 px-4 py-2 text-purple-400 hover:bg-purple-600 hover:text-white transition"
          >
            エモートからインポート
          </button>
          <button
            onClick={() => setShowForm(true)}
            className="rounded-lg bg-purple-600 px-4 py-2 text-white hover:bg-purple-700"
          >
            {UI_STRINGS.CARD_MANAGER.ADD_NEW_CARD}
          </button>
        </div>
      </div>

      {/* Storage usage info displayed at panel level */}
      {/* ストレージ使用量をパネルレベルで表示 */}
      {storageStatus && (
        <div className="mb-6">
          {storageStatus.uploadDisabled && storageStatus.message ? (
            <div className="rounded-lg bg-yellow-500/10 border border-yellow-500/30 p-3 text-sm text-yellow-300">
              <p className="font-medium mb-1">アップロード機能が制限されています</p>
              <p className="text-yellow-400/80 text-xs leading-relaxed">{storageStatus.message}</p>
            </div>
          ) : (
            <p className="text-sm text-gray-400">
              画像使用量: {storageStatus.userUsageFormatted} / {storageStatus.userLimitFormatted}
            </p>
          )}
        </div>
      )}

      {/* Card Form Modal */}
      {/* カードフォームモーダル */}
      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={resetForm}>
          <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-xl bg-gray-800 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <form onSubmit={handleSubmit} className="p-6">
              <div className="mb-4 flex items-center justify-between">
                <h3 className="text-lg font-semibold text-white">
                  {editingCard ? UI_STRINGS.CARD_MANAGER.EDIT_CARD : UI_STRINGS.CARD_MANAGER.NEW_CARD}
                </h3>
                <button
                  type="button"
                  onClick={resetForm}
                  className="text-gray-400 hover:text-white"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
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
                      {deletingImage ? "削除中..." : "削除"}
                    </button>
                  </div>
                )}

                {/* Show cropped image preview when a file has been cropped */}
                {/* トリミング済みファイルがある場合はプレビュー表示 */}
                {croppedFile && croppedPreviewUrl && (
                  <div className="flex items-center gap-3 rounded-lg bg-green-900/30 border border-green-600/50 p-3">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={croppedPreviewUrl}
                      alt="トリミング済みプレビュー"
                      className="h-[60px] w-[60px] rounded object-cover"
                    />
                    <div className="flex-1">
                      <p className="text-sm text-green-300">トリミング済み画像</p>
                      <p className="text-xs text-gray-400">400x400px (JPEG)</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        // Clean up preview URL and reset cropped file
                        // プレビューURLをクリーンアップしてトリミング済みファイルをリセット
                        if (croppedPreviewUrl) {
                          URL.revokeObjectURL(croppedPreviewUrl);
                        }
                        setCroppedPreviewUrl(null);
                        setCroppedFile(null);
                      }}
                      className="rounded bg-red-500 px-3 py-1 text-sm text-white hover:bg-red-600"
                    >
                      取り消し
                    </button>
                  </div>
                )}

                {/* Show file input when no confirmed image or user has modified the field */}
                {/* 確定済み画像がないか、ユーザーが操作した場合にファイル入力を表示 */}
                {(!confirmedImageUrl || userModifiedImage) && !croppedFile && (
                  <>
                    <input
                      type="file"
                      name="image"
                      accept="image/*"
                      ref={fileInputRef}
                      onChange={handleFileChange}
                      disabled={storageStatus?.uploadDisabled}
                      className={`w-full text-sm text-gray-400 file:mr-4 file:rounded-lg file:border-0 file:px-4 file:py-2 file:text-sm file:font-semibold file:text-white ${
                        storageStatus?.uploadDisabled
                          ? 'opacity-50 cursor-not-allowed file:bg-gray-500'
                          : 'file:bg-purple-600 hover:file:bg-purple-700'
                      }`}
                    />
                    <p className="text-xs text-gray-500">
                      {/* File size limit removed since cropping compresses to 400x400 JPEG */}
                      {/* トリミングで400x400 JPEGに圧縮されるためファイルサイズ制限を削除 */}
                      {UI_STRINGS.CARD_MANAGER.FILE_UPLOAD.FORMATS}（400x400にトリミング）
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
              <div className="mb-1 flex items-center gap-2">
                <label className="text-sm text-gray-300">
                  {UI_STRINGS.CARD_MANAGER.FORM_LABELS.DROP_RATE}
                </label>
                <button
                  type="button"
                  onClick={() => setShowDropRateInfo(true)}
                  className="text-gray-400 hover:text-white"
                  title="出現確率について"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                </button>
              </div>
              <div className="mb-2 flex items-center gap-3 text-sm">
                <span className="text-gray-400">
                  重み: <span className="text-white font-medium">{(formData.dropRate * 100).toFixed(1)}%</span>
                </span>
                <span className="text-gray-500">→</span>
                <span className="text-gray-400">
                  実際の確率: <span className="text-green-400 font-medium">{calculateActualProbability(formData.dropRate).toFixed(1)}%</span>
                </span>
              </div>
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
              <div className="mt-6 flex gap-4">
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
          </div>
        </div>
      )}

      {/* View toggle (shown when showViewToggle is true) */}
      {/* ビュートグル（showViewToggleがtrueの場合に表示） */}
      {showViewToggle && cards.length > 0 && (
        <div className="mb-4 flex justify-end">
          <CardViewToggle
            viewMode={currentViewMode}
            onViewModeChange={setCurrentViewMode}
          />
        </div>
      )}

      {/* Card List/Grid */}
      {/* カード一覧（リスト/グリッド） */}
      {(() => {
        // Use server pagination if provided, otherwise client-side
        // サーバーページングが提供されている場合はそれを使用、そうでなければクライアントサイド
        const useServerPagination = !!serverPagination;

        // For server pagination, cards are already paginated
        // サーバーページングの場合、カードは既にページネーション済み
        let displayCards = cards;

        // Apply maxCards limit if specified (for preview mode)
        // maxCardsが指定されている場合は制限を適用（プレビューモード用）
        if (maxCards) {
          displayCards = displayCards.slice(0, maxCards);
        }

        // Apply client-side pagination if enabled and not using server pagination
        // サーバーページングを使用していない場合、クライアントサイドページネーションを適用
        const totalPages = useServerPagination
          ? serverPagination.totalPages
          : enablePagination
          ? Math.ceil(displayCards.length / cardsPerPage)
          : 1;

        const currentPageNum = useServerPagination
          ? serverPagination.currentPage
          : currentPage;

        if (!useServerPagination && enablePagination && totalPages > 1) {
          const startIndex = (currentPage - 1) * cardsPerPage;
          const endIndex = startIndex + cardsPerPage;
          displayCards = displayCards.slice(startIndex, endIndex);
        }

        // Handle page change based on pagination type
        // ページネーションタイプに基づいてページ変更を処理
        const onPageChange = useServerPagination
          ? handleServerPageChange
          : setCurrentPage;

        if (cards.length === 0) {
          return (
            <p className="text-center text-gray-400">
              {UI_STRINGS.CARD_MANAGER.MESSAGES.EMPTY_CARDS}
            </p>
          );
        }

        return (
          <>
            {/* List view */}
            {/* リスト表示 */}
            {currentViewMode === "list" ? (
              <CardList
                cards={displayCards}
                onEdit={handleEdit}
                onDelete={handleDelete}
                onToggleActive={handleToggleActive}
                showActions={true}
              />
            ) : (
              /* Thumbnail grid view */
              /* サムネイルグリッド表示 */
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {displayCards.map((card, index) => {
                  const rarityInfo = getRarityInfo(card.rarity);
                  const isPaused = !card.is_active;
                  // First 4 cards get priority for LCP optimization
                  // 最初の4枚のカードはLCP最適化のためpriority設定
                  const isPriority = index < 4;
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
                            priority={isPriority}
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

            {/* Pagination and total count display */}
            {/* ページネーションと総数表示 */}
            {enablePagination && (
              <div className="mt-6 flex flex-col items-center gap-2">
                {/* Total count display for server pagination */}
                {/* サーバーページング用の総数表示 */}
                {serverPagination && serverPagination.total > 0 && (
                  <p className="text-sm text-gray-400">
                    全 {serverPagination.total} 件中 {(serverPagination.currentPage - 1) * serverPagination.perPage + 1} - {Math.min(serverPagination.currentPage * serverPagination.perPage, serverPagination.total)} 件を表示
                  </p>
                )}
                {/* Show pagination controls only when there are multiple pages */}
                {/* 複数ページある場合のみページネーションコントロールを表示 */}
                {totalPages > 1 && (
                  <Pagination
                    currentPage={currentPageNum}
                    totalPages={totalPages}
                    onPageChange={onPageChange}
                  />
                )}
              </div>
            )}
          </>
        );
      })()}

      {/* Drop Rate Info Modal */}
      {/* 出現確率説明モーダル */}
      {showDropRateInfo && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70" onClick={() => setShowDropRateInfo(false)}>
          <div className="mx-4 max-w-lg rounded-xl bg-gray-800 p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-lg font-semibold text-white">出現確率について</h3>
              <button
                onClick={() => setShowDropRateInfo(false)}
                className="text-gray-400 hover:text-white"
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="space-y-4 text-gray-300">
              <p>
                <strong className="text-white">「重み」</strong>は相対的な出現しやすさを表します。
                実際の出現確率は、全カードの重みの合計に対する割合で計算されます。
              </p>
              <div className="rounded-lg bg-gray-700 p-4">
                <p className="mb-2 text-sm text-gray-400">計算式:</p>
                <p className="font-mono text-sm text-white">
                  実際の確率 = このカードの重み ÷ 全カードの重みの合計 × 100%
                </p>
              </div>
              <div className="rounded-lg bg-gray-700 p-4">
                <p className="mb-2 text-sm text-gray-400">例:</p>
                <ul className="space-y-1 text-sm">
                  <li>• カードA: 重み10%、カードB: 重み10%、カードC: 重み10%</li>
                  <li className="text-green-400">→ 各カードの実際の確率: 10÷30×100 = <strong>33.3%</strong></li>
                </ul>
                <ul className="mt-2 space-y-1 text-sm">
                  <li>• カードA: 重み50%、カードB: 重み25%</li>
                  <li className="text-green-400">→ カードA: 50÷75×100 = <strong>66.7%</strong>、カードB: <strong>33.3%</strong></li>
                </ul>
              </div>
              <p className="text-sm text-gray-400">
                ※ 配布停止中のカードは確率計算に含まれません。
              </p>
            </div>
            <button
              onClick={() => setShowDropRateInfo(false)}
              className="mt-6 w-full rounded-lg bg-purple-600 py-2 text-white hover:bg-purple-700"
            >
              閉じる
            </button>
          </div>
        </div>
      )}

      {/* Image Cropper Modal */}
      {/* 画像トリミングモーダル */}
      {cropModalOpen && selectedFileForCrop && (
        <ImageCropper
          imageFile={selectedFileForCrop}
          onCropComplete={handleCropComplete}
          onCancel={handleCropCancel}
        />
      )}

      {/* Emote Import Modal */}
      {/* エモートインポートモーダル */}
      {showEmoteModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={() => setShowEmoteModal(false)}>
          <div className="max-h-[90vh] w-full max-w-4xl overflow-hidden rounded-xl bg-gray-800 shadow-2xl flex flex-col" onClick={(e) => e.stopPropagation()}>
            {/* Modal Header */}
            {/* モーダルヘッダー */}
            <div className="p-6 border-b border-gray-700">
              <div className="flex items-center justify-between">
                <h3 className="text-lg font-semibold text-white">エモートからカードを作成</h3>
                <button
                  onClick={() => setShowEmoteModal(false)}
                  className="text-gray-400 hover:text-white"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
              <p className="mt-2 text-sm text-gray-400">
                チャンネルのエモートを選択してカードを作成します。既にカードになっているエモートは除外されます。
              </p>
            </div>

            {/* Modal Body */}
            {/* モーダル本文 */}
            <div className="flex-1 overflow-y-auto p-6">
              {/* Error message */}
              {/* エラーメッセージ */}
              {emoteError && (
                <div className="mb-4 rounded-lg bg-red-900/30 border border-red-600/50 p-3 text-sm text-red-300">
                  {emoteError}
                </div>
              )}

              {/* Loading state */}
              {/* ローディング状態 */}
              {loadingEmotes && (
                <div className="flex items-center justify-center py-12">
                  <div className="text-gray-400">エモートを読み込み中...</div>
                </div>
              )}

              {/* Emote list */}
              {/* エモート一覧 */}
              {!loadingEmotes && emotes.length > 0 && (
                <>
                  {/* Selection controls */}
                  {/* 選択コントロール */}
                  <div className="mb-4 flex items-center justify-between">
                    <div className="text-sm text-gray-400">
                      {getAvailableEmotes().length === 0 ? (
                        "全てのエモートが既にカードになっています"
                      ) : (
                        <>
                          {selectedEmotes.size} / {getAvailableEmotes().length} 件選択中
                          {emotes.length !== getAvailableEmotes().length && (
                            <span className="ml-2 text-yellow-400">
                              （{emotes.length - getAvailableEmotes().length} 件は既存カードと重複）
                            </span>
                          )}
                        </>
                      )}
                    </div>
                    <div className="flex gap-2">
                      <button
                        onClick={selectAllEmotes}
                        className="text-sm text-purple-400 hover:text-purple-300"
                        disabled={getAvailableEmotes().length === 0}
                      >
                        全て選択
                      </button>
                      <span className="text-gray-600">|</span>
                      <button
                        onClick={deselectAllEmotes}
                        className="text-sm text-purple-400 hover:text-purple-300"
                      >
                        選択解除
                      </button>
                    </div>
                  </div>

                  {/* Emote grid */}
                  {/* エモートグリッド */}
                  <div className="grid grid-cols-4 sm:grid-cols-6 md:grid-cols-8 gap-3">
                    {emotes.map((emote) => {
                      const isExisting = !getAvailableEmotes().find(e => e.id === emote.id);
                      const isSelected = selectedEmotes.has(emote.id);
                      return (
                        <button
                          key={emote.id}
                          onClick={() => !isExisting && toggleEmoteSelection(emote.id)}
                          disabled={isExisting}
                          className={`relative rounded-lg p-2 transition ${
                            isExisting
                              ? "bg-gray-700/50 opacity-50 cursor-not-allowed"
                              : isSelected
                              ? "bg-purple-600 ring-2 ring-purple-400"
                              : "bg-gray-700 hover:bg-gray-600"
                          }`}
                          title={isExisting ? "既にカードとして存在します" : emote.name}
                        >
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={emote.imageUrl}
                            alt={emote.name}
                            className="w-full aspect-square object-contain"
                          />
                          <p className="mt-1 text-xs text-center text-gray-300 truncate">
                            {emote.name}
                          </p>
                          {isExisting && (
                            <div className="absolute inset-0 flex items-center justify-center">
                              <span className="bg-gray-900/80 px-2 py-1 rounded text-xs text-gray-400">
                                作成済み
                              </span>
                            </div>
                          )}
                          {isSelected && (
                            <div className="absolute top-1 right-1 bg-purple-500 rounded-full p-0.5">
                              <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                              </svg>
                            </div>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </>
              )}

              {/* No emotes state */}
              {/* エモートがない状態 */}
              {!loadingEmotes && emotes.length === 0 && !emoteError && (
                <div className="text-center py-12 text-gray-400">
                  チャンネルにエモートがありません。
                  <br />
                  Twitchアフィリエイト/パートナーでエモートを設定してください。
                </div>
              )}
            </div>

            {/* Modal Footer */}
            {/* モーダルフッター */}
            <div className="p-6 border-t border-gray-700 bg-gray-800/50">
              {/* Default settings for new cards */}
              {/* 新規カードのデフォルト設定 */}
              <div className="mb-4 grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm text-gray-400 mb-1">デフォルトレアリティ</label>
                  <select
                    value={emoteDefaultRarity}
                    onChange={(e) => setEmoteDefaultRarity(e.target.value as Rarity)}
                    className="w-full rounded-lg bg-gray-700 px-3 py-2 text-white text-sm"
                  >
                    {RARITIES.map((r) => (
                      <option key={r.value} value={r.value}>
                        {r.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-sm text-gray-400 mb-1">
                    デフォルト重み: {(emoteDefaultDropRate * 100).toFixed(0)}%
                  </label>
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.01"
                    value={emoteDefaultDropRate}
                    onChange={(e) => setEmoteDefaultDropRate(parseFloat(e.target.value))}
                    className="w-full"
                  />
                </div>
              </div>

              {/* Action buttons */}
              {/* アクションボタン */}
              <div className="flex justify-end gap-3">
                <button
                  onClick={() => setShowEmoteModal(false)}
                  className="rounded-lg border border-gray-600 px-4 py-2 text-gray-300 hover:bg-gray-700"
                >
                  キャンセル
                </button>
                <button
                  onClick={createCardsFromEmotes}
                  disabled={selectedEmotes.size === 0 || creatingCards}
                  className="rounded-lg bg-purple-600 px-4 py-2 text-white hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {creatingCards ? "作成中..." : `${selectedEmotes.size}件のカードを作成`}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
