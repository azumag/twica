"use client";

import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import Image from "next/image";
import { useTranslations } from "next-intl";
import type { Card, Rarity } from "@/types/database";
import { RARITIES, DEFAULT_RARITY_WEIGHTS, CARD_DESCRIPTION_MAX_CHARACTERS } from "@/lib/constants";
import { logger } from "@/lib/logger";
import { formatRarityLabel, getRarityDisplayInfo } from "@/lib/rarity";
import { getOptimizedImageUrl } from "@/lib/image-utils";
import { validateUpload, getUploadErrorMessage } from "@/lib/upload-validation";
import { countCharacters } from "@/lib/text-utils";
import { DEFAULT_PACK_SENTINEL } from "@/lib/validation/collection-name";
import { cardMatchesPackKey } from "@/lib/collection-packs";
import { isAllowedCardUploadFile, shouldPreserveOriginalCardUpload } from "@/lib/card-upload-mode";
import { MAX_ISSUANCE_COUNT_CAP } from "@/lib/card-issuance";
import ImageCropper, { type CropMode, getCropModes } from "./ImageCropper";
import CardViewToggle, { type ViewMode } from "./CardViewToggle";
import CardList from "./CardList";
import DropRateSettingsModal from "./DropRateSettingsModal";
import CustomRarityModal from "./CustomRarityModal";
import CardPackModal from "./CardPackModal";
import ExpandableDescription from "./ExpandableDescription";

/** Custom dropdown arrow style for appearance-none select boxes */
const SELECT_ARROW_STYLE: React.CSSProperties = {
  backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 20 20' fill='%239ca3af'%3E%3Cpath fill-rule='evenodd' d='M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z' clip-rule='evenodd'/%3E%3C/svg%3E")`,
  backgroundPosition: "right 0.5rem center",
  backgroundSize: "1.25rem",
  backgroundRepeat: "no-repeat",
};

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
  // プランダウングレード後のストレージ超過フラグ
  planOverLimit?: boolean;
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


interface CardManagerProps {
  streamerId: string;
  initialCards: Card[];
  // Initial view mode (default: 'thumbnail')
  // 初期表示モード（デフォルト: 'thumbnail'）
  viewMode?: ViewMode;
  // Whether to show view toggle buttons (default: false)
  // 表示切り替えボタンを表示するかどうか（デフォルト: false）
  showViewToggle?: boolean;
  // Maximum number of cards to display (for preview mode)
  // 表示するカードの最大数（プレビューモード用）
  maxCards?: number;
  // Plan-based max image width in pixels (default: 800)
  // プラン別カード画像最大幅（デフォルト: 800px）
  maxImageWidth?: number;
  // Plan-based available output widths (default: [800])
  // プラン別選択可能な出力幅（デフォルト: [800]）
  availableWidths?: number[];
  // Plan-based maximum upload size in bytes (default: UPLOAD_CONFIG.MAX_FILE_SIZE)
  // GIFはトリミング/再圧縮をスキップして原本送信されるため、UI上でユーザーへ上限を案内するのに利用する
  // プラン別アップロードサイズ上限（バイト）。GIF原本送信モード時の注意文表示にも用いる
  maxUploadSize?: number;
  // Initial rarity weights: null/undefined = unset (auto mode with defaults), {} = explicit manual mode, {weights} = auto mode
  // レアリティ確率設定: null/undefined=未設定（自動モードデフォルト化）, {}=手動モード明示, {weights}=自動モード
  initialRarityWeights?: Record<string, number> | null;
  // 配信者が定義したカスタムレアリティ名（rarity_weights とは独立）
  // Streamer-defined custom rarity names (decoupled from rarity_weights)
  initialCustomRarities?: string[];
  // 配信者が事前登録したカードパック名（Issue #393再設計）。カード作成/編集
  // フォームの collectionName は自由入力ではなく、このリストからのみ選択する。
  // Pre-defined card pack names (Issue #393 redesign). The collectionName
  // field on the card form now only selects from this list, not free text.
  initialCardPackNames?: string[];
  // 「デフォルト」(未分類)パックの表示名オーバーライド（Issue #554）。
  // null/undefined は汎用ラベル("デフォルト")を意味する(列未デプロイ時も含む)。
  // Display-name override for the "default" (unclassified) pack (Issue #554).
  // null/undefined falls back to the generic label ("デフォルト").
  initialDefaultPackName?: string | null;
  // Issue #269再設計: 新規パック登録(パック管理モーダルでの追加)にのみ適用する
  // プラン判定。デフォルトfalse(フェイルクローズ)。
  isPremium?: boolean;
}

// Sorting field options
// 並び替えフィールドの選択肢
type SortField = "display_order" | "created_at" | "rarity" | "card_number" | "drop_rate";
type CardFormData = {
  name: string;
  description: string;
  imageUrl: string;
  rarity: Rarity;
  cardNumber: string;
  maxIssuanceCount: string;
  // Issue #393: card pack name ("" = unclassified / all cards)
  collectionName: string;
  dropRate: number;
  intraRarityWeight: number;
};

// Sorting direction options
// 並び替え方向の選択肢
type SortDirection = "asc" | "desc";

// Status filter options
// ステータスフィルターの選択肢
type StatusFilter = "all" | "active" | "inactive";

const compareCardsByDisplayOrder = (a: Card, b: Card): number => {
  const numberDiff =
    (a.card_number ?? Number.MAX_SAFE_INTEGER) -
    (b.card_number ?? Number.MAX_SAFE_INTEGER);
  if (numberDiff !== 0) return numberDiff;

  const createdAtDiff = new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
  if (createdAtDiff !== 0) return createdAtDiff;

  return a.id.localeCompare(b.id);
};

export default function CardManager({
  streamerId,
  initialCards,
  viewMode: initialViewMode = "thumbnail",
  showViewToggle = false,
  maxCards,
  maxImageWidth = 800,
  availableWidths = [800],
  maxUploadSize,
  initialRarityWeights = null,
  initialCustomRarities = [],
  initialCardPackNames = [],
  initialDefaultPackName = null,
  isPremium = false,
}: CardManagerProps) {
  // i18n translations
  // i18n翻訳
  const t = useTranslations("cardManager");
  const tCommon = useTranslations("common");
  const tRarity = useTranslations("rarity");
  const getRarityLabel = useCallback(
    (rarity: string) => formatRarityLabel(rarity, tRarity),
    [tRarity]
  );
  const [cards, setCards] = useState<Card[]>(initialCards);
  // DB値の変換: null=未設定→デフォルト自動モード, {}=手動モード明示, {weights}=自動モード
  const [rarityWeights, setRarityWeights] = useState<Record<string, number> | null>(() => {
    if (initialRarityWeights === null || initialRarityWeights === undefined) {
      return { ...DEFAULT_RARITY_WEIGHTS };
    }
    if (Object.keys(initialRarityWeights).length === 0) {
      return null; // {} = 手動モード明示のセンチネル
    }
    return initialRarityWeights;
  });
  // カスタムレアリティ名（ドロップ率設定とは独立。専用モーダルで管理）
  const [customRarities, setCustomRarities] = useState<string[]>(initialCustomRarities);
  // 事前登録カードパック名（Issue #393再設計。専用モーダルで管理）
  const [cardPackNames, setCardPackNames] = useState<string[]>(initialCardPackNames);
  // 「デフォルト」(未分類)パックの表示名オーバーライド（Issue #554。専用モーダルで管理）
  const [defaultPackName, setDefaultPackName] = useState<string | null>(initialDefaultPackName);
  const rarityOptions = useMemo(() => {
    const values = new Set<string>(RARITIES.map((rarity) => rarity.value));
    cards.forEach((card) => {
      if (card.rarity.trim()) values.add(card.rarity);
    });
    Object.keys(rarityWeights ?? {}).forEach((rarity) => {
      if (rarity.trim()) values.add(rarity);
    });
    customRarities.forEach((rarity) => {
      if (rarity.trim()) values.add(rarity);
    });
    return Array.from(values);
  }, [cards, rarityWeights, customRarities]);
  const [loading, setLoading] = useState(false);
  // Current view mode state (thumbnail or list)
  // 現在の表示モード状態（サムネイルまたはリスト）
  const [currentViewMode, setCurrentViewMode] = useState<ViewMode>(initialViewMode);
  // Track if initial view mode has been set based on screen size
  // 画面サイズに基づいて初期表示モードが設定されたかどうかを追跡
  const hasSetInitialViewMode = useRef(false);

  // Sorting and filtering state
  // 並び替えとフィルタリングの状態
  // Default sort: 設定日（created_at）降順
  // 初期表示は最新の設定（作成）日順とし、サーバー側 initialCards のソートと一致させる
  const [sortField, setSortField] = useState<SortField>("created_at");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  // パックフィルタ（Issue #554）。"" = すべてのパック、DEFAULT_PACK_SENTINEL =
  // デフォルト(未分類, collection_name IS NULL)のみ、それ以外はパック名の完全一致。
  // ステータスフィルタと異なり、サーバー(/api/cards)側にこの絞り込みパラメータは
  // 無いため、常にクライアント側(filteredAndSortedCards)のみで完結させる。
  const [packFilter, setPackFilter] = useState<string>("");
  const [titleSearchQuery, setTitleSearchQuery] = useState("");
  // Track if this is the first render to skip initial reload
  // 初回レンダリングかどうかを追跡して初期リロードをスキップ
  const isFirstRender = useRef(true);

  /**
   * Reload all cards from server (called when sort/filter changes)
   * サーバーから全カードを再読み込み（並び替え/フィルター変更時に呼び出し）
   */
  const reloadCards = useCallback(async () => {
    setLoading(true);
    try {
      // Build API URL with sort/filter parameters, fetch all cards (limit=1000)
      // 並び替え/フィルターパラメータでAPI URLを構築、全カードを取得（limit=1000）
      const params = new URLSearchParams({
        streamerId,
        limit: "1000",
        offset: "0",
        sortField,
        sortDirection,
        status: statusFilter,
      });
      const url = `/api/cards?${params.toString()}`;
      const response = await fetch(url);
      if (response.ok) {
        const data = await response.json();
        setCards(data.cards);
      } else {
        logger.error("[CardManager] reloadCards failed:", response.status);
      }
    } catch (error) {
      logger.error("Failed to reload cards:", error);
    } finally {
      setLoading(false);
    }
  }, [streamerId, sortField, sortDirection, statusFilter]);

  /**
   * Effect to set initial view mode based on screen size
   * On mobile (< 640px), default to thumbnail mode for better usability
   * モバイル（640px未満）では使いやすさのためサムネイルモードをデフォルトにする
   */
  useEffect(() => {
    if (!hasSetInitialViewMode.current && window.innerWidth < 640) {
      setCurrentViewMode("thumbnail");
    }
    hasSetInitialViewMode.current = true;
  }, []);

  /**
   * Effect to reload cards when sort/filter parameters change
   * 並び替え/フィルターパラメータが変更されたらカードを再読み込み
   */
  useEffect(() => {
    // Skip first render (use initialCards from props)
    // 初回レンダリングはスキップ（propsのinitialCardsを使用）
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    reloadCards();
  }, [sortField, sortDirection, statusFilter, reloadCards]);

  /**
   * Client-side filtering for optimistic updates
   * Server handles sorting, client only filters for immediate UI feedback
   * 楽観的更新用のクライアントサイドフィルタリング
   * サーバーがソートを処理、クライアントは即時UIフィードバックのためフィルタリングのみ
   */
  const filteredAndSortedCards = useMemo(() => {
    const normalizedQuery = titleSearchQuery.trim().toLowerCase();
    // Only apply client-side filter for optimistic updates (toggle active)
    // 楽観的更新（アクティブ切り替え）用にクライアントサイドフィルターのみ適用
    let nextCards = cards;
    if (statusFilter === "active") {
      nextCards = nextCards.filter(card => card.is_active);
    } else if (statusFilter === "inactive") {
      nextCards = nextCards.filter(card => !card.is_active);
    }
    // Issue #554: パックフィルタ。DEFAULT_PACK_SENTINEL は「未分類のみ」
    // (collection_name IS NULL)、それ以外は選択されたパック名との完全一致。
    // cardMatchesPackKey は executeGacha の抽選プール絞り込みと同じ述語を
    // 共有しており(collection-packs.ts)、表示用フィルタと抽選プールの判定が
    // ズレないようにする。
    if (packFilter) {
      nextCards = nextCards.filter(card => cardMatchesPackKey(card.collection_name, packFilter));
    }
    if (normalizedQuery) {
      nextCards = nextCards.filter(card => card.name.toLowerCase().includes(normalizedQuery));
    }

    if (sortField === "display_order") {
      nextCards = [...nextCards].sort(compareCardsByDisplayOrder);
      if (sortDirection === "desc") {
        nextCards.reverse();
      }
    }

    return nextCards;
  }, [cards, sortDirection, sortField, statusFilter, packFilter, titleSearchQuery]);

  // Issue #554: パックフィルタの選択肢 = 事前登録カタログ ∪ カード上に実在する
  // collection_name(パック管理から削除された等の孤立参照も選択肢から漏らさない)。
  const packFilterOptions = useMemo(() => {
    const names = new Set<string>(cardPackNames);
    cards.forEach((card) => {
      if (card.collection_name) names.add(card.collection_name);
    });
    return Array.from(names);
  }, [cardPackNames, cards]);

  // Calculate total weight for probability calculation.
  // Issue #565: 確率列の母数は実際の抽選プールに一致させる。パック指定の
  // 報酬から引いた場合、GachaService.executeGacha は active + collection
  // で候補を絞り、selectWeightedCard が候補内の drop_rate 比で抽選する
  // (=パック内で再正規化)。そこでパックフィルタ選択中は同じ絞り込みを
  // 母数に適用し、「そのパックから引いたときの抽選確率」を表示する。
  // statusFilter/タイトル検索は表示用フィルタであり抽選プールとは無関係の
  // ため母数には影響させない。
  const totalActiveWeight = useMemo(
    () =>
      cards
        .filter(
          (c) =>
            c.is_active &&
            (!packFilter || cardMatchesPackKey(c.collection_name, packFilter))
        )
        .reduce((sum, c) => sum + c.drop_rate, 0),
    [cards, packFilter]
  );

  const [showForm, setShowForm] = useState(false);
  const [editingCard, setEditingCard] = useState<Card | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [formData, setFormData] = useState<CardFormData>({
    name: "",
    description: "",
    imageUrl: "",
    rarity: "common" as Rarity,
    cardNumber: "",
    maxIssuanceCount: "",
    collectionName: "",
    dropRate: 0.25,
    intraRarityWeight: 1.0,
  });
  // Issue #393再設計: 事前登録パック一覧 + (編集中カードの現在値がその一覧に
  // 無ければ)孤立参照を選択肢として残す(ChannelPointSettingsの「一覧に無い
  // パックも表示」パターンと同じ。パック管理から削除された後の既存紐付けを
  // 黙って見えなくしない)。
  // Issue #567続き: 孤立参照のアンカーは formData.collectionName ではなく
  // editingCard.collection_name(編集開始時点の元の値)で行う。デフォルトへ
  // 変更した直後は formData.collectionName が "" になり cardPackNames が
  // 空だと選択肢がゼロになって select 自体がアンマウントされ、孤立参照へ
  // 戻せなくなる(下の表示ゲート参照)。editingCard を見ることで、編集
  // セッション中は select が消えず、いつでも元のパックへ戻せる。
  const cardPackSelectOptions = useMemo(() => {
    const options = [...cardPackNames];
    if (editingCard?.collection_name && !options.includes(editingCard.collection_name)) {
      options.push(editingCard.collection_name);
    }
    if (formData.collectionName && !options.includes(formData.collectionName)) {
      options.push(formData.collectionName);
    }
    return options;
  }, [cardPackNames, editingCard, formData.collectionName]);
  const descriptionCharacterCount = useMemo(
    () => countCharacters(formData.description),
    [formData.description]
  );
  const isDescriptionTooLong = descriptionCharacterCount > CARD_DESCRIPTION_MAX_CHARACTERS;
  const [saving, setSaving] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  // Issue #393再設計: デプロイ窓(card_pack_names列未検出)でパック紐付けだけ
  // 保留された稀なケースの通知。resetForm()がuploadErrorを即座にクリアする
  // ため、フォームの表示状態から独立させる。
  const [deployWindowNotice, setDeployWindowNotice] = useState(false);
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
  // ?アイコンクリックで容量制限の理由説明を表示するためのトグル状態
  const [showStorageHelp, setShowStorageHelp] = useState(false);
  // Loading state for storage status refresh
  // ストレージ状態更新中のローディング状態
  const [storageLoading, setStorageLoading] = useState(false);
  // Image cropping modal state
  // 画像トリミングモーダルの状態
  const [cropModalOpen, setCropModalOpen] = useState(false);
  // Crop mode selection modal state (shown before cropper)
  // トリミングモード選択モーダルの状態（クロッパー表示前に表示）
  const [cropModeModalOpen, setCropModeModalOpen] = useState(false);
  // Selected crop mode: square (800x800) or portrait (800x1118)
  // ユーザーが選択した出力解像度（デフォルトはプラン最大幅）
  const [selectedWidth, setSelectedWidth] = useState<number>(maxImageWidth);
  // 選択されたトリミングモード: 正方形(800x800)またはポートレイト(800x1118)
  const [selectedCropMode, setSelectedCropMode] = useState<CropMode>("square");
  // Original file selected for cropping (before crop)
  // トリミング対象として選択されたオリジナルファイル（トリミング前）
  const [selectedFileForCrop, setSelectedFileForCrop] = useState<File | null>(null);
  // アップロード画像の実際の幅（解像度フィルタリング用）
  const [sourceImageWidth, setSourceImageWidth] = useState<number | null>(null);
  // 画像サイズ読み取りの非同期コールバック無効化用カウンター
  // Counter to invalidate stale async image dimension callbacks
  const imageDimensionRequestId = useRef(0);
  // Cropped image file ready for upload
  // アップロード準備完了のトリミング済み画像ファイル
  const [croppedFile, setCroppedFile] = useState<File | null>(null);
  // Preview URL for cropped image (managed separately to avoid memory leaks)
  // トリミング済み画像のプレビューURL（メモリリーク防止のため別管理）
  const [croppedPreviewUrl, setCroppedPreviewUrl] = useState<string | null>(null);
  // Image URL validation loading state
  // 画像URL検証中のローディング状態
  const [imageUrlValidating, setImageUrlValidating] = useState(false);

  // ユーザー選択幅に応じた動的クロップモード設定
  const planCropModes = useMemo(() => getCropModes(selectedWidth), [selectedWidth]);

  // 画像サイズに基づく選択可能な解像度リスト
  // Filter available widths to those not exceeding source image dimensions
  const effectiveWidths = useMemo(() => {
    const selectable = sourceImageWidth
      ? availableWidths.filter((w) => w <= sourceImageWidth)
      : availableWidths;
    return selectable.length > 0 ? selectable : [Math.min(...availableWidths)];
  }, [availableWidths, sourceImageWidth]);

  // Emote import modal state
  // エモートインポートモーダルの状態
  const [showEmoteModal, setShowEmoteModal] = useState(false);
  // Batch drop rate modal state
  // 確率一括調整モーダルの状態
  const [showBatchDropRateModal, setShowBatchDropRateModal] = useState(false);
  // カスタムレアリティ管理モーダルの状態
  const [showCustomRarityModal, setShowCustomRarityModal] = useState(false);
  // パック管理モーダルの状態(Issue #393再設計)
  const [showCardPackModal, setShowCardPackModal] = useState(false);
  // Zoomed card image modal state (opened when user clicks a thumbnail)
  // Uses the original (pre-thumbnail) URL so users see the full-resolution image
  // サムネイルクリック時に表示する拡大画像モーダルの状態
  // サムネイル最適化前の元URLを保持し、高解像度のまま表示する
  const [zoomedImage, setZoomedImage] = useState<{ url: string; name: string } | null>(null);
  // Stores the thumbnail button that opened the modal so we can return focus when closed
  // モーダルを開いた元のサムネイルボタンを保持し、閉じた際にフォーカスを戻すための参照
  const zoomTriggerRef = useRef<HTMLButtonElement | null>(null);
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
  const [showCardNumberEditor, setShowCardNumberEditor] = useState(false);
  const [cardNumberDrafts, setCardNumberDrafts] = useState<Record<string, string>>({});
  const [savingCardNumbers, setSavingCardNumbers] = useState(false);
  const [cardNumberEditorMessage, setCardNumberEditorMessage] = useState<{
    type: "error" | "success" | "info";
    text: string;
  } | null>(null);

  // Fetch storage status
  // ストレージ状態を取得
  const fetchStorageStatus = useCallback(async () => {
    setStorageLoading(true);
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
    } finally {
      setStorageLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStorageStatus();
  }, [fetchStorageStatus]);

  // Close the zoom modal when Escape is pressed and restore focus to the trigger
  // Escape キー押下時に拡大画像モーダルを閉じ、元のサムネイルへフォーカスを戻す
  useEffect(() => {
    if (!zoomedImage) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setZoomedImage(null);
        const trigger = zoomTriggerRef.current;
        zoomTriggerRef.current = null;
        if (trigger) {
          requestAnimationFrame(() => trigger.focus());
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [zoomedImage]);

  // 未設定の配信者向けにデフォルトレアリティ重みをDBに自動保存（マウント時1回のみ）
  const autoSavedWeightsRef = useRef(false);
  useEffect(() => {
    if (autoSavedWeightsRef.current) return;
    if (initialRarityWeights !== null && initialRarityWeights !== undefined) return;
    autoSavedWeightsRef.current = true;

    fetch("/api/streamer/settings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      credentials: "include",
      body: JSON.stringify({
        streamerId,
        rarityWeights: DEFAULT_RARITY_WEIGHTS,
      }),
    })
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then(data => {
        if (Array.isArray(data.recalculatedCards)) {
          const recalculated = data.recalculatedCards as Card[];
          setCards(prev => {
            const recalculatedMap = new Map(recalculated.map(c => [c.id, c]));
            return prev.map(card => recalculatedMap.get(card.id) || card);
          });
        }
      })
      .catch((err) => {
        // 失敗時にフラグをリセット→次回マウントでリトライ可能にする
        logger.error("Failed to auto-save default rarity weights:", err);
        autoSavedWeightsRef.current = false;
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
        setCards((prevCards) => {
          const createdCards = result.cards as Card[];
          const createdCardIds = new Set(createdCards.map((card) => card.id));
          const merged = [...createdCards, ...prevCards.filter((card) => !createdCardIds.has(card.id))];
          return mergeRecalculatedCards(merged, result.recalculatedCards as Card[] | null | undefined);
        });
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

  const cardNumberEditorCards = useMemo(() => {
    return [...cards].sort((a, b) => {
      const numberDiff = (a.card_number ?? Number.MAX_SAFE_INTEGER) - (b.card_number ?? Number.MAX_SAFE_INTEGER);
      if (numberDiff !== 0) return numberDiff;
      const createdAtDiff = new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
      if (createdAtDiff !== 0) return createdAtDiff;
      return a.id.localeCompare(b.id);
    });
  }, [cards]);

  const openCardNumberEditor = () => {
    setCardNumberDrafts(
      Object.fromEntries(cards.map((card) => [card.id, card.card_number ? String(card.card_number) : ""]))
    );
    setCardNumberEditorMessage(null);
    setShowCardNumberEditor(true);
  };

  const parseCardNumberDraft = (value: string): number | null | "invalid" => {
    const trimmed = value.trim();
    if (trimmed === "") return null;
    if (!/^\d+$/.test(trimmed)) return "invalid";
    const parsed = Number(trimmed);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) return "invalid";
    return parsed;
  };

  const validateCardNumberDrafts = (): Array<{ card: Card; cardNumber: number | null }> | null => {
    const seen = new Map<number, string>();
    const updates: Array<{ card: Card; cardNumber: number | null }> = [];

    for (const card of cards) {
      const parsed = parseCardNumberDraft(cardNumberDrafts[card.id] ?? "");
      if (parsed === "invalid") {
        setCardNumberEditorMessage({ type: "error", text: t("cardNumberEditor.invalid") });
        return null;
      }
      if (parsed !== null) {
        if (seen.has(parsed)) {
          setCardNumberEditorMessage({
            type: "error",
            text: t("cardNumberEditor.duplicate", { number: parsed }),
          });
          return null;
        }
        seen.set(parsed, card.id);
      }
      if ((card.card_number ?? null) !== parsed) {
        updates.push({ card, cardNumber: parsed });
      }
    }

    return updates;
  };

  const saveCardNumbers = async () => {
    const updates = validateCardNumberDrafts();
    if (!updates) return;
    if (updates.length === 0) {
      setCardNumberEditorMessage({ type: "info", text: t("cardNumberEditor.noChanges") });
      return;
    }

    setSavingCardNumbers(true);
    setCardNumberEditorMessage(null);
    try {
      const updateCardNumber = async (card: Card, cardNumber: number | null): Promise<Card> => {
        const response = await fetch(`/api/cards/${card.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ cardNumber }),
        });

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({ error: "Unknown error" }));
          throw new Error(errorData.error || t("messages.errorOccurred", { status: response.status }));
        }

        const responseData = await response.json();
        const savedCardData = { ...(responseData as Record<string, unknown>) };
        delete savedCardData.recalculatedCards;
        return savedCardData as unknown as Card;
      };

      const updatedCards: Card[] = [];
      for (const update of updates) {
        if (update.card.card_number !== null) {
          await updateCardNumber(update.card, null);
        }
      }
      for (const update of updates) {
        if (update.cardNumber === null) {
          updatedCards.push({ ...update.card, card_number: null });
        } else {
          updatedCards.push(await updateCardNumber(update.card, update.cardNumber));
        }
      }

      handleBatchDropRateSave(updatedCards);
      setCardNumberDrafts((prevDrafts) => {
        const nextDrafts = { ...prevDrafts };
        for (const card of updatedCards) {
          nextDrafts[card.id] = card.card_number ? String(card.card_number) : "";
        }
        return nextDrafts;
      });
      setCardNumberEditorMessage({ type: "success", text: t("cardNumberEditor.saved") });
    } catch (error) {
      logger.error("Failed to save card numbers:", error);
      setCardNumberEditorMessage({
        type: "error",
        text: error instanceof Error ? error.message : t("messages.errorOccurred", { status: 500 }),
      });
    } finally {
      setSavingCardNumbers(false);
    }
  };

  /**
   * Handle batch drop rate save
   * 確率一括調整の保存処理
   * Updates local cards state with the updated cards from the API response
   * APIレスポンスから更新されたカードでローカルカード状態を更新
   */
  const handleBatchDropRateSave = useCallback((updatedCards: Card[]) => {
    setCards(prevCards => {
      // Create a map of updated cards for quick lookup
      // 高速検索用に更新されたカードのマップを作成
      const updatedMap = new Map(updatedCards.map(c => [c.id, c]));
      // Replace cards that were updated, keep others as-is
      // 更新されたカードを置き換え、他はそのまま維持
      return prevCards.map(card => updatedMap.get(card.id) || card);
    });
  }, []);

  const mergeRecalculatedCards = useCallback(
    (baseCards: Card[], recalculatedCards: Card[] | null | undefined): Card[] => {
      if (!recalculatedCards || recalculatedCards.length === 0) {
        return baseCards;
      }
      const recalculatedMap = new Map(recalculatedCards.map((card) => [card.id, card]));
      return baseCards.map((card) => recalculatedMap.get(card.id) || card);
    },
    []
  );

  const handleRarityWeightsApply = useCallback(
    (nextRarityWeights: Record<string, number> | null, recalculatedCards: Card[] | null) => {
      setRarityWeights(nextRarityWeights);
      if (recalculatedCards) {
        setCards((prevCards) => mergeRecalculatedCards(prevCards, recalculatedCards));
      }
    },
    [mergeRecalculatedCards]
  );

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

  // Calculate intra-rarity share and overall probability for auto mode preview
  // 自動モード時のレアリティ内シェアと全体確率を計算
  const calculateIntraRarityStats = useCallback((intraWeight: number, rarity: string) => {
    if (!rarityWeights) return null;
    const targetPercent = rarityWeights[rarity];
    if (targetPercent === undefined || targetPercent <= 0) return null;

    // Sum intra weights for all active cards in the same rarity (excluding the editing card)
    // 同レアリティの全アクティブカードのintra weightを合算（編集中カードは除外）
    const sameRarityCards = cards.filter(
      c => c.is_active && c.rarity === rarity && (!editingCard || c.id !== editingCard.id)
    );
    const othersIntraSum = sameRarityCards.reduce(
      (sum, c) => sum + (c.intra_rarity_weight ?? 1.0), 0
    );
    const totalIntraWeight = othersIntraSum + intraWeight;
    // Share within this rarity (e.g., 40% of Rare pool)
    const intraPercent = totalIntraWeight > 0
      ? (intraWeight / totalIntraWeight) * 100
      : 0;
    // Overall drop probability (e.g., 4% of all drops)
    const overallPercent = totalIntraWeight > 0
      ? (targetPercent / 100) * (intraWeight / totalIntraWeight) * 100
      : 0;
    const cardCount = sameRarityCards.length + 1; // +1 for current card
    return { intraPercent, overallPercent, cardCount, targetPercent };
  }, [cards, editingCard, rarityWeights]);

  // Handle image removal and let the update API clean up the previous image if needed
  // 画像削除処理。必要なら既存画像のクリーンアップは更新API側で行う
  const handleRemoveImage = () => {
    if (!confirmedImageUrl) return;

    // Clear UI immediately
    // UIは即座にクリア
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
      cardNumber: "",
      maxIssuanceCount: "",
      collectionName: "",
      dropRate: 0.25,
      intraRarityWeight: 1.0,
    });
    setConfirmedImageUrl("");
    setUserModifiedImage(true);
    setEditingCard(null);
    setShowForm(false);
    setUploadError(null);
    // Reset cropping state
    // トリミング状態をリセット
    imageDimensionRequestId.current++;
    setCropModalOpen(false);
    setCropModeModalOpen(false);
    setSelectedCropMode("square");
    setSelectedWidth(maxImageWidth);
    setSelectedFileForCrop(null);
    setSourceImageWidth(null);
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
      // Cropped image will be compressed to JPEG, so original size doesn't matter
      // トリミング前はファイルタイプのみ検証（サイズチェックはスキップ）
      // トリミング後はJPEGに圧縮されるため、元のサイズは問題にならない
      if (!isAllowedCardUploadFile(file)) {
        setUploadError(getUploadErrorMessage("INVALID_FILE_TYPE"));
        return;
      }
      if (shouldPreserveOriginalCardUpload(file)) {
        // GIFはトリミング/再圧縮されず原本のままアップロードされるため、
        // クライアント側でもプラン上限を事前にチェックし UX を早期化する
        // （サーバ側 validateUpload でも最終的に弾かれるが、無駄なネットワークを避ける）
        const validation = validateUpload(file, maxUploadSize);
        if (!validation.valid) {
          setUploadError(getUploadErrorMessage(validation.error!));
          return;
        }
        imageDimensionRequestId.current++;
        if (croppedPreviewUrl) {
          URL.revokeObjectURL(croppedPreviewUrl);
        }
        setSelectedFileForCrop(null);
        setSourceImageWidth(null);
        setCropModeModalOpen(false);
        setCropModalOpen(false);
        setSelectedCropMode("square");
        setCroppedFile(file);
        setCroppedPreviewUrl(URL.createObjectURL(file));
        return;
      }
      // 画像の実サイズを読み取ってからモーダルを開く
      // Read actual image dimensions before opening the modal
      const requestId = ++imageDimensionRequestId.current;
      const img = document.createElement("img");
      const objectUrl = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(objectUrl);
        // キャンセルや再選択で無効化されたコールバックを無視
        // Ignore stale callback from cancelled/re-selected file
        if (requestId !== imageDimensionRequestId.current) return;
        const imgWidth = img.naturalWidth;
        setSourceImageWidth(imgWidth);
        // 画像幅以下の解像度のうち最大のものをデフォルトに設定
        // Default to the largest resolution that doesn't exceed image width
        const validWidths = availableWidths.filter((w) => w <= imgWidth);
        const defaultWidth = validWidths.length > 0
          ? Math.max(...validWidths)
          : Math.min(...availableWidths);
        setSelectedWidth(defaultWidth);
        setSelectedFileForCrop(file);
        setCropModeModalOpen(true);
      };
      img.onerror = () => {
        URL.revokeObjectURL(objectUrl);
        if (requestId !== imageDimensionRequestId.current) return;
        // 読み取り失敗時はフォールバック：従来通り全選択肢を表示
        setSourceImageWidth(null);
        setSelectedWidth(maxImageWidth);
        setSelectedFileForCrop(file);
        setCropModeModalOpen(true);
      };
      img.src = objectUrl;
    }
  };

  /**
   * Handles crop mode selection and opens the cropper
   * トリミングモード選択後にクロッパーを開く
   */
  const handleCropModeSelect = (mode: CropMode) => {
    setSelectedCropMode(mode);
    setCropModeModalOpen(false);
    setCropModalOpen(true);
  };

  /**
   * Cancels crop mode selection
   * トリミングモード選択をキャンセル
   */
  const handleCropModeCancel = () => {
    imageDimensionRequestId.current++;
    setCropModeModalOpen(false);
    setSelectedFileForCrop(null);
    setSourceImageWidth(null);
    // Clear the file input
    // ファイル入力をクリア
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
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
    imageDimensionRequestId.current++;
    setCropModalOpen(false);
    setSelectedFileForCrop(null);
    setSourceImageWidth(null);
    // Clear the file input
    // ファイル入力をクリア
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  /**
   * Validates image URL for aspect ratio and resolution limits
   * Image must be portrait (height >= width) or square
   * 画像URLのアスペクト比と解像度制限を検証（プラン別の最大幅に対応）
   */
  const validateImageUrl = useCallback(async (url: string): Promise<boolean> => {
    if (!url) return true;

    // プラン別の最大幅に基づいて解像度上限を算出
    // ポートレイトのアスペクト比(1118/800)を考慮した最大高さ
    const MAX_WIDTH = maxImageWidth;
    const MAX_HEIGHT = Math.round(maxImageWidth * (1118 / 800));

    setImageUrlValidating(true);
    setUploadError(null);

    return new Promise((resolve) => {
      const img = document.createElement("img");
      // Note: crossOrigin is NOT set intentionally
      // Setting crossOrigin="anonymous" would cause CORS errors for servers
      // that don't return CORS headers, making valid image URLs fail to load
      // crossOriginを設定しないのは意図的です
      // crossOrigin="anonymous"を設定するとCORSヘッダーを返さないサーバーの
      // 画像が読み込めなくなり、正常なURLでもエラーになります

      img.onload = () => {
        const width = img.naturalWidth;
        const height = img.naturalHeight;

        // Check if image is portrait (height >= width) or square
        // 画像が縦長（高さ >= 幅）または正方形かチェック
        const isPortraitOrSquare = height >= width;
        if (!isPortraitOrSquare) {
          setUploadError(t("messages.imageUrlInvalidAspectRatio", { width, height }));
          setImageUrlValidating(false);
          setFormData(prev => ({ ...prev, imageUrl: "" }));
          resolve(false);
          return;
        }

        // Check resolution limits
        // 解像度制限をチェック
        if (width > MAX_WIDTH || height > MAX_HEIGHT) {
          setUploadError(t("messages.imageUrlResolutionExceeded", { maxWidth: MAX_WIDTH, maxHeight: MAX_HEIGHT, width, height }));
          setImageUrlValidating(false);
          setFormData(prev => ({ ...prev, imageUrl: "" }));
          resolve(false);
          return;
        }

        // Validation passed - confirm the URL
        // 検証成功 - URLを確定
        setConfirmedImageUrl(url);
        setImageUrlValidating(false);
        resolve(true);
      };

      img.onerror = () => {
        setUploadError(t("messages.imageUrlLoadFailed"));
        setImageUrlValidating(false);
        setFormData(prev => ({ ...prev, imageUrl: "" }));
        resolve(false);
      };

      img.src = url;
    });
  }, [t, maxImageWidth]);

  const handleEdit = (card: Card) => {
    setEditingCard(card);
    setFormData({
      name: card.name,
      description: card.description || "",
      imageUrl: card.image_url || "",
      rarity: card.rarity,
      cardNumber: card.card_number ? String(card.card_number) : "",
      maxIssuanceCount: card.max_issuance_count ? String(card.max_issuance_count) : "",
      collectionName: card.collection_name || "",
      dropRate: card.drop_rate,
      intraRarityWeight: card.intra_rarity_weight ?? 1.0,
    });
    setConfirmedImageUrl(card.image_url || "");
    // Hide URL input initially only when editing card with existing image
    // 既存画像がある場合のみ、URL入力欄を初期状態で非表示
    setUserModifiedImage(!card.image_url);
    setShowForm(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (isDescriptionTooLong) {
      return;
    }

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
            setUploadError(errorData.error || t("messages.rateLimit"));
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
          cardNumber: formData.cardNumber.trim() === "" ? null : Number(formData.cardNumber),
          maxIssuanceCount: formData.maxIssuanceCount.trim() === "" ? null : Number(formData.maxIssuanceCount),
          // Issue #393: send the pack name (trimmed "" → null clears it = all cards)
          collectionName: formData.collectionName.trim() === "" ? null : formData.collectionName.trim(),
          dropRate: formData.dropRate,
          // intraRarityWeightはautoMode時のみ送信（手動モードでは不要）
          ...(rarityWeights !== null ? { intraRarityWeight: formData.intraRarityWeight } : {}),
        }),
      });

      if (response.ok) {
        const responseData = await response.json();
        const recalculatedCards = Array.isArray(responseData.recalculatedCards)
          ? (responseData.recalculatedCards as Card[])
          : null;
        // Issue #393再設計: デプロイ窓(card_pack_names列未検出)でパック紐付け
        // だけ保留された、稀なケース用のフラグ。読み取り後に取り除いて
        // Card型に無い合成フィールドが state に漏れないようにする。
        const collectionNameSkippedDeployWindow = responseData.collectionNameSkippedDeployWindow === true;
        const savedCardData = { ...(responseData as Record<string, unknown>) };
        delete savedCardData.recalculatedCards;
        delete savedCardData.collectionNameSkippedDeployWindow;
        const savedCard = savedCardData as unknown as Card;
        setDeployWindowNotice(collectionNameSkippedDeployWindow);

        if (editingCard) {
          setCards((prevCards) => {
            const replacedCards = prevCards.map((card) => (
              card.id === editingCard.id ? savedCard : card
            ));
            return mergeRecalculatedCards(replacedCards, recalculatedCards);
          });
          // Refresh storage status after update (old image may have been deleted)
          // 更新後にストレージ状態を更新（古い画像が削除された可能性があるため）
          fetchStorageStatus();
        } else {
          setCards((prevCards) => {
            const nextCards = [savedCard, ...prevCards.filter((card) => card.id !== savedCard.id)];
            return mergeRecalculatedCards(nextCards, recalculatedCards);
          });
        }
        resetForm();
      } else if (response.status === 429) {
        const errorData = await response.json();
        setUploadError(errorData.error || t("messages.rateLimit"));
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
      } else {
        const responseData = await response.json();
        const recalculatedCards = Array.isArray(responseData.recalculatedCards)
          ? (responseData.recalculatedCards as Card[])
          : null;
        const updatedCardData = { ...(responseData as Record<string, unknown>) };
        delete updatedCardData.recalculatedCards;
        const updatedCard = updatedCardData as unknown as Card;

        setCards((prevCards) => {
          const replacedCards = prevCards.map((currentCard) => (
            currentCard.id === card.id ? updatedCard : currentCard
          ));
          return mergeRecalculatedCards(replacedCards, recalculatedCards);
        });
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
          const errorMessage = errorData.error || t("messages.rateLimit");
          alert(t("messages.operationFailed", { msg: errorMessage }));
          logger.error("Rate limit exceeded:", errorData);
        } else {
          setCards(originalCards);
          const errorData = await response.json().catch(() => ({ error: "Unknown error" }));
          const errorMessage = errorData.error || t("messages.deleteFailed");
          alert(`${t("messages.deleteFailedPrefix")} ${errorMessage}`);
          logger.error("Delete failed:", errorData);
        }
      } else {
        const result = await response.json().catch(() => null);
        if (result && Array.isArray(result.recalculatedCards)) {
          setCards((prevCards) => mergeRecalculatedCards(prevCards, result.recalculatedCards as Card[]));
        }
        // Success: refresh storage status to reflect deleted image
        // 成功: 削除された画像を反映するためストレージ状態を更新
        fetchStorageStatus();
      }
    } catch (error) {
      // Revert on network error
      setCards(originalCards);
      logger.error("Failed to delete card:", error);
      alert(t("messages.networkErrorDelete"));
    }
  };

  const getRarityInfo = (rarity: Rarity) => getRarityDisplayInfo(rarity);

  return (
    <div className="rounded-xl bg-gray-800 p-6">
      {/* Header section - stacks vertically on mobile for better button readability */}
      {/* ヘッダーセクション - モバイルではボタンの可読性向上のため縦並び */}
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h2 className="text-xl font-semibold text-white">{t("title")}</h2>
        <div className="flex flex-col gap-2 sm:flex-row">
          {/* Drop rate settings button */}
          {/* カード排出確率設定ボタン */}
          <button
            onClick={() => setShowBatchDropRateModal(true)}
            className="rounded-lg border border-purple-600 px-4 py-2 text-purple-400 hover:bg-purple-600 hover:text-white transition whitespace-nowrap"
          >
            {t("dropRateSettings.button")}
          </button>
          {/* Custom rarity management button */}
          {/* カスタムレアリティ管理ボタン */}
          <button
            onClick={() => setShowCustomRarityModal(true)}
            className="rounded-lg border border-purple-600 px-4 py-2 text-purple-400 hover:bg-purple-600 hover:text-white transition whitespace-nowrap"
          >
            {t("customRarity.button")}
          </button>
          {/* Card pack management button (Issue #393再設計) */}
          {/* パック管理ボタン */}
          <button
            onClick={() => setShowCardPackModal(true)}
            className="rounded-lg border border-purple-600 px-4 py-2 text-purple-400 hover:bg-purple-600 hover:text-white transition whitespace-nowrap"
          >
            {t("cardPackModal.button")}
          </button>
          {/* Emote import button */}
          {/* エモートインポートボタン */}
          <button
            onClick={openEmoteModal}
            className="rounded-lg border border-purple-600 px-4 py-2 text-purple-400 hover:bg-purple-600 hover:text-white transition whitespace-nowrap"
          >
            {t("importFromEmotes")}
          </button>
          <button
            onClick={openCardNumberEditor}
            className="rounded-lg border border-purple-600 px-4 py-2 text-purple-400 hover:bg-purple-600 hover:text-white transition whitespace-nowrap"
          >
            {t("editCardNumbers")}
          </button>
          <button
            onClick={() => setShowForm(true)}
            className="rounded-lg bg-purple-600 px-4 py-2 text-white hover:bg-purple-700 whitespace-nowrap"
          >
            {t("addNewCard")}
          </button>
        </div>
      </div>

      {/* Plan over limit warning banner */}
      {/* プラン容量超過警告バナー */}
      {storageStatus?.planOverLimit && (
        <div className="mb-4 rounded-lg bg-red-500/10 border border-red-500/30 p-4">
          <p className="font-medium text-red-300 mb-1">{t("messages.uploadLimited")}</p>
          <p className="text-sm text-red-400/80">
            {storageStatus.message}
          </p>
          <a href="/plans" className="mt-2 inline-block text-xs text-purple-400 hover:text-purple-300 underline">
            支援特典について
          </a>
        </div>
      )}

      {/* Issue #393再設計: デプロイ窓(card_pack_names列未検出)でパック紐付けが
          保留された稀なケース用の通知。フォームは保存成功時に閉じるため
          form表示状態から独立させたスタンドアロンバナー。 */}
      {deployWindowNotice && (
        <div className="mb-4 rounded-lg bg-yellow-500/10 border border-yellow-500/30 p-4">
          <p className="text-sm text-yellow-300">{t("form.collectionNameDeployWindow")}</p>
        </div>
      )}

      {/* Storage usage info displayed at panel level */}
      {/* ストレージ使用量をパネルレベルで表示 */}
      {storageStatus && (
        <div className="mb-6">
          {storageStatus.uploadDisabled && storageStatus.message && !storageStatus.planOverLimit ? (
            <div className="rounded-lg bg-yellow-500/10 border border-yellow-500/30 p-3 text-sm text-yellow-300">
              <p className="font-medium mb-1">{t("messages.uploadLimited")}</p>
              <p className="text-yellow-400/80 text-xs leading-relaxed">{storageStatus.message}</p>
              <a href="/plans" className="mt-1 inline-block text-xs text-purple-400 hover:text-purple-300 underline">
                支援特典について
              </a>
            </div>
          ) : (
            <div className="text-sm text-gray-400 flex items-center gap-2">
              <p>{t("messages.imageUsage", { usage: storageStatus.userUsageFormatted, limit: storageStatus.userLimitFormatted })}</p>
              {/* ?アイコン: クリックで容量制限の理由を表示 */}
              <button
                type="button"
                onClick={() => setShowStorageHelp((v) => !v)}
                className="inline-flex items-center justify-center w-4 h-4 rounded-full border border-gray-500 text-gray-400 hover:text-gray-200 hover:border-gray-300 text-[10px] leading-none transition-colors"
                aria-label={t("messages.uploadLimited")}
              >
                ?
              </button>
              {storageLoading && (
                <span className="inline-flex items-center gap-1 text-purple-400">
                  <svg className="animate-spin h-3 w-3" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
                  <span className="text-xs">{t("messages.refreshing")}</span>
                </span>
              )}
            </div>
          )}
          {/* 容量制限の説明テキスト: ?アイコンクリックで表示/非表示を切り替え */}
          {showStorageHelp && !storageStatus.uploadDisabled && (
            <div className="mt-2">
              <p className="text-yellow-400/80 text-xs leading-relaxed">{storageStatus.message || t("messages.storageLimitReason")}</p>
              <a href="/plans" className="mt-1 inline-block text-xs text-purple-400 hover:text-purple-300 underline">
                支援特典について
              </a>
            </div>
          )}
        </div>
      )}

      {/* Card Form Modal */}
      {/* カードフォームモーダル - 外クリックでキャンセルしない（誤操作防止のため、明示的にキャンセルボタンを押す必要がある） */}
      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-xl bg-gray-800 shadow-2xl">
            <form onSubmit={handleSubmit} className="p-4 sm:p-6">
              <div className="mb-4 flex items-center justify-between">
                <h3 className="text-lg font-semibold text-white">
                  {editingCard ? t("editCard") : t("newCard")}
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
              <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                {/* 左カラム: カード名 + レアリティを縦積み（右の画像ペーンと高さを揃える） */}
                <div className="flex min-w-0 flex-col justify-between gap-4">
                  <div className="min-w-0">
                    <label className="mb-1 block text-sm text-gray-300">
                      {t("form.name")} *
                    </label>
                    <input
                      type="text"
                      name="name"
                      required
                      placeholder={t("form.namePlaceholder")}
                      value={formData.name}
                      onChange={(e) =>
                        setFormData({ ...formData, name: e.target.value })
                      }
                      className="w-full min-w-0 rounded-lg bg-gray-600 px-4 py-2 text-white"
                    />
                  </div>
                  <div className="min-w-0">
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                      <div className="min-w-0">
                        <label className="mb-1 block text-sm text-gray-300">
                          {t("form.rarity")}
                        </label>
                        {/*
                          レアリティ選択は <select> を使用する。
                          以前は <input list> + <datalist> だったが、datalist は
                          入力欄の現在値に部分一致する候補のみを表示する仕様のため、
                          初期値 "common" が入っている状態ではコモンしか候補に出ず
                          実質的に他のレアリティを選べない不具合があった。
                          <select> なら現在値に関わらず常に全選択肢を表示できる。
                          rarityOptions はデフォルト4種＋既存カードのレアリティ＋
                          カスタムレアリティ(rarity_weights)を含むため、デフォルトの
                          レアリティは常に保持される。
                        */}
                        <select
                          name="rarity"
                          value={formData.rarity}
                          onChange={(e) =>
                            setFormData({ ...formData, rarity: e.target.value as Rarity })
                          }
                          className="w-full min-w-0 appearance-none rounded-lg bg-gray-600 px-4 py-2 pr-8 text-white"
                          style={SELECT_ARROW_STYLE}
                        >
                          {rarityOptions.map((rarity) => (
                            <option key={rarity} value={rarity}>
                              {getRarityLabel(rarity)}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="min-w-0">
                        <label className="mb-1 block text-sm text-gray-300">
                          {t("form.cardNumber")}
                        </label>
                        <input
                          type="number"
                          name="cardNumber"
                          min="1"
                          step="1"
                          inputMode="numeric"
                          placeholder={t("form.cardNumberPlaceholder")}
                          value={formData.cardNumber}
                          onChange={(e) =>
                            setFormData({ ...formData, cardNumber: e.target.value })
                          }
                          className="w-full min-w-0 rounded-lg bg-gray-600 px-4 py-2 text-white placeholder:text-gray-300"
                        />
                        <p className="mt-1 text-xs text-gray-300">
                          {t("form.cardNumberHelp")}
                        </p>
                      </div>
                      <div>
                        <label className="mb-1 block text-sm text-gray-300">
                          {t("form.maxIssuanceCount")}
                        </label>
                        <input
                          type="number"
                          name="maxIssuanceCount"
                          min="1"
                          max={MAX_ISSUANCE_COUNT_CAP}
                          step="1"
                          inputMode="numeric"
                          placeholder={t("form.maxIssuanceCountPlaceholder")}
                          value={formData.maxIssuanceCount}
                          onChange={(e) =>
                            setFormData({ ...formData, maxIssuanceCount: e.target.value })
                          }
                          className="w-full rounded-lg bg-gray-600 px-4 py-2 text-white placeholder:text-gray-300"
                        />
                        <p className="mt-1 text-xs text-gray-300">
                          {t("form.maxIssuanceCountHelp")}
                        </p>
                      </div>
                    </div>
                    {/* Issue #393再設計: カードパックは自由入力ではなく、事前に
                        「パック管理」で登録した一覧から選択する(レアリティselectと
                        同じパターン)。新規登録はパック管理モーダル側でのみ発生する
                        ため、ここでの選択は常にゲート対象外。 */}
                    {/* Issue #567: 選べるパックが1つも無い場合(デフォルト1択)は
                        セレクト自体を出さない。cardPackSelectOptions は登録済み
                        パック ∪ 編集中カードの孤立参照(editingCard.collection_name
                        をアンカーにする。formData の現在値だけを見ると、デフォルト
                        へ変更した直後に選択肢がゼロになり select ごと消えて孤立
                        参照へ戻せなくなるため)なので、孤立参照カードの編集セッション
                        中は select が常にマウントされたままとなり、デフォルトへ
                        変更してもいつでも元のパックへ戻せる。非表示時は
                        collectionName が "" のまま = 未分類(null)で保存される。 */}
                    {cardPackSelectOptions.length > 0 && (
                      <div className="mt-3 min-w-0">
                        <label className="mb-1 block text-sm text-gray-300">
                          {t("form.collectionName")}
                        </label>
                        <select
                          name="collectionName"
                          value={formData.collectionName}
                          onChange={(e) =>
                            setFormData({ ...formData, collectionName: e.target.value })
                          }
                          className="w-full min-w-0 rounded-lg bg-gray-600 px-4 py-2 text-white"
                        >
                          <option value="">
                            {t("form.collectionNameUnclassified", {
                              name: defaultPackName ?? t("cardPackModal.defaultName"),
                            })}
                          </option>
                          {cardPackSelectOptions.map((name) => (
                            <option key={name} value={name}>{name}</option>
                          ))}
                        </select>
                        <p className="mt-1 text-xs text-gray-300">
                          {t("form.collectionNameHelp")}
                        </p>
                      </div>
                    )}
                  </div>
                </div>
                {/* 右カラム: 画像 */}
                <div className="min-w-0">
              <label className="mb-1 block text-sm text-gray-300">
                {t("form.image")}
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
                    {/* unoptimized: User-uploaded images are already optimized (400x400 JPEG) */}
                    {/* Skip Vercel Image Transformations to reduce usage costs */}
                    {/* unoptimized: ユーザーアップロード画像は既に最適化済み(400x400 JPEG) */}
                    {/* Vercel Image Transformations をスキップして使用量を削減 */}
                    <Image
                      src={confirmedImageUrl}
                      alt={t("form.currentImage")}
                      width={60}
                      height={60}
                      className="rounded object-cover"
                      unoptimized
                    />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm text-gray-300">{t("form.currentImage")}</p>
                      <p className="text-xs text-gray-500 truncate max-w-[200px]">
                        {confirmedImageUrl.split('/').pop()}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={handleRemoveImage}
                      className="rounded bg-red-500 px-3 py-1 text-sm text-white hover:bg-red-600"
                    >
                      {tCommon("delete")}
                    </button>
                  </div>
                )}

                {/* Show selected upload preview when a file is ready */}
                {/* アップロード準備済みファイルがある場合はプレビュー表示 */}
                {croppedFile && croppedPreviewUrl && (
                  <div className="flex items-center gap-3 rounded-lg bg-green-900/30 border border-green-600/50 p-3">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={croppedPreviewUrl}
                      alt={t("form.croppedImage")}
                      className={`rounded object-cover ${selectedCropMode === "portrait" ? "h-[84px] w-[60px]" : "h-[60px] w-[60px]"}`}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm text-green-300">
                        {shouldPreserveOriginalCardUpload(croppedFile)
                          ? t("form.originalAnimatedImage")
                          : t("form.croppedImage")}
                      </p>
                      <p className="text-xs text-gray-400">
                        {shouldPreserveOriginalCardUpload(croppedFile)
                          ? t("form.originalAnimatedImageHelp")
                          : `${planCropModes[selectedCropMode].dimensions}px (${planCropModes[selectedCropMode].label})`}
                      </p>
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
                      {t("buttons.undo")}
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
                      className={`w-full min-w-0 text-sm text-gray-400 file:mr-4 file:rounded-lg file:border-0 file:px-4 file:py-2 file:text-sm file:font-semibold file:text-white ${
                        storageStatus?.uploadDisabled
                          ? 'opacity-50 cursor-not-allowed file:bg-gray-500'
                          : 'file:bg-purple-600 hover:file:bg-purple-700'
                      }`}
                    />
                    <p className="text-xs text-gray-500">
                      {/* File size limit removed since cropping compresses to JPEG */}
                      {/* トリミングでJPEGに圧縮されるためファイルサイズ制限を削除 */}
                      {t("fileUpload.formats")}{t("form.cropNoteWithOptions", { square: planCropModes.square.dimensions, portrait: planCropModes.portrait.dimensions })}
                      {t("form.animatedGifNote")}
                    </p>
                    {/* GIFはトリミング/再圧縮されず原本のままアップロードされるため、
                        プラン上限 (basic=1MB, support=5MB, patron/twitch_sub=10MB) を明示する */}
                    <p className="text-xs text-amber-400">
                      {t("form.animatedGifSizeLimit", {
                        maxMb: Math.floor((maxUploadSize ?? 1 * 1024 * 1024) / (1024 * 1024)),
                      })}
                    </p>
                    <input
                      type="url"
                      name="imageUrl"
                      placeholder={t("form.imageUrlPlaceholder")}
                      value={formData.imageUrl}
                      onChange={(e) =>
                        setFormData({ ...formData, imageUrl: e.target.value })
                      }
                      onBlur={() => {
                        // Validate and confirm URL on blur, mark as user modified
                        // フォーカスが外れた時にURLを検証・確定し、ユーザー操作フラグを設定
                        if (formData.imageUrl) {
                          validateImageUrl(formData.imageUrl);
                        }
                        setUserModifiedImage(true);
                      }}
                      disabled={imageUrlValidating}
                      className="w-full min-w-0 rounded-lg bg-gray-600 px-4 py-2 text-white disabled:opacity-50"
                    />
                    {/* Show validating indicator when checking image URL */}
                    {/* 画像URL検証中の表示 */}
                    {imageUrlValidating && (
                      <p className="text-sm text-purple-400 flex items-center gap-2">
                        <svg className="animate-spin h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                        </svg>
                        {t("messages.imageUrlValidating")}
                      </p>
                    )}
                  </>
                )}
              </div>
            </div>
            {/* 手動モード: 出現確率スライダー / 自動モード: レアリティ内重み（1行レイアウト） */}
            {rarityWeights === null ? (
            <div className="md:col-span-2">
              <div className="mb-1 flex items-center gap-2">
                <label className="text-sm text-gray-300">
                  {t("form.dropRate")}
                </label>
                <button
                  type="button"
                  onClick={() => setShowDropRateInfo(true)}
                  className="text-gray-400 hover:text-white"
                  title={t("dropRateInfo.title")}
                >
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                </button>
              </div>
              <div className="mb-2 flex items-center gap-3 text-sm">
                <span className="text-gray-400">
                  {t("dropRateInfo.weight")}: <span className="text-white font-medium">{(formData.dropRate * 100).toFixed(1)}%</span>
                </span>
                <span className="text-gray-500">→</span>
                <span className="text-gray-400">
                  {t("dropRateInfo.actualProbability")}: <span className="text-green-400 font-medium">{calculateActualProbability(formData.dropRate).toFixed(1)}%</span>
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
            ) : (
              <div className="md:col-span-2">
                <label className="mb-1 block text-sm text-gray-300">{t("form.intraRarityWeight")}</label>
                <div className="flex items-center gap-3">
                  <input
                    type="range"
                    min="0.1"
                    max="10"
                    step="0.1"
                    value={formData.intraRarityWeight}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        intraRarityWeight: parseFloat(e.target.value),
                      })
                    }
                    className="h-2 flex-1 cursor-pointer appearance-none rounded-full bg-gray-600 accent-purple-500"
                  />
                  {/* レアリティ内シェアと全体確率のインラインプレビュー */}
                  {(() => {
                    const stats = calculateIntraRarityStats(formData.intraRarityWeight, formData.rarity);
                    if (!stats) return null;
                    return (
                      <span className="flex items-center gap-2 text-xs text-gray-400 shrink-0">
                        <span>{getRarityLabel(formData.rarity)}内: <span className="text-white">{stats.intraPercent.toFixed(0)}%</span></span>
                        <span className="text-gray-500">→</span>
                        <span>{t("form.overallDropRate")}: <span className="text-green-400">{stats.overallPercent.toFixed(1)}%</span></span>
                      </span>
                    );
                  })()}
                </div>
              </div>
            )}
            <div className="md:col-span-2">
              <label className="mb-1 block text-sm text-gray-300">{t("form.description")}</label>
              <textarea
                name="description"
                value={formData.description}
                onChange={(e) =>
                  setFormData({ ...formData, description: e.target.value })
                }
                rows={3}
                aria-invalid={isDescriptionTooLong}
                className={`w-full rounded-lg px-4 py-2 text-white ${
                  isDescriptionTooLong
                    ? "bg-gray-600 ring-1 ring-red-500"
                    : "bg-gray-600"
                }`}
              />
              <div className="mt-2 flex items-center justify-between gap-3 text-xs">
                <span className={isDescriptionTooLong ? "text-red-400" : "text-gray-400"}>
                  {t("form.descriptionCount", {
                    current: descriptionCharacterCount,
                    max: CARD_DESCRIPTION_MAX_CHARACTERS,
                  })}
                </span>
                {isDescriptionTooLong && (
                  <span className="text-red-400">
                    {t("messages.descriptionTooLong", { max: CARD_DESCRIPTION_MAX_CHARACTERS })}
                  </span>
                )}
              </div>
            </div>
          </div>
              <div className="mt-6 flex gap-4">
                <button
                  type="submit"
                  disabled={saving || isDescriptionTooLong}
                  className="rounded-lg bg-purple-600 px-6 py-2 text-white hover:bg-purple-700 disabled:opacity-50"
                >
                  {saving ? t("buttons.saving") : editingCard ? tCommon("update") : tCommon("add")}
                </button>
                <button
                  type="button"
                  onClick={resetForm}
                  className="rounded-lg border border-gray-600 px-6 py-2 text-gray-300 hover:bg-gray-600"
                >
                  {tCommon("cancel")}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Card number bulk editor modal */}
      {/* カード番号の一括編集モーダル */}
      {showCardNumberEditor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className="max-h-[90vh] w-full max-w-3xl overflow-hidden rounded-xl bg-gray-800 shadow-2xl">
            <div className="flex items-center justify-between border-b border-gray-700 p-4 sm:p-6">
              <div>
                <h3 className="text-lg font-semibold text-white">{t("cardNumberEditor.title")}</h3>
                <p className="mt-1 text-sm text-gray-300">{t("cardNumberEditor.description")}</p>
              </div>
              <button
                type="button"
                onClick={() => setShowCardNumberEditor(false)}
                className="text-gray-400 hover:text-white"
                aria-label={tCommon("cancel")}
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="max-h-[60vh] overflow-y-auto p-4 sm:p-6">
              {cardNumberEditorMessage && (
                <div
                  className={`mb-4 rounded-lg border px-3 py-2 text-sm ${
                    cardNumberEditorMessage.type === "error"
                      ? "border-red-500/40 bg-red-500/10 text-red-300"
                      : cardNumberEditorMessage.type === "success"
                        ? "border-green-500/40 bg-green-500/10 text-green-300"
                        : "border-gray-500/40 bg-gray-700 text-gray-300"
                  }`}
                >
                  {cardNumberEditorMessage.text}
                </div>
              )}

              <div className="space-y-2">
                {cardNumberEditorCards.map((card) => (
                  <div
                    key={card.id}
                    className="grid grid-cols-[minmax(0,1fr)_7rem] items-center gap-3 rounded-lg bg-gray-700/70 p-3"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-white">{card.name}</p>
                      <p className="text-xs text-gray-400">
                        {card.card_number ? `#${card.card_number}` : t("cardNumberEditor.auto")}
                      </p>
                    </div>
                    <div>
                      <label className="sr-only" htmlFor={`card-number-${card.id}`}>
                        {t("cardNumberEditor.numberLabel")}
                      </label>
                      <input
                        id={`card-number-${card.id}`}
                        type="number"
                        min="1"
                        step="1"
                        inputMode="numeric"
                        placeholder={t("cardNumberEditor.auto")}
                        value={cardNumberDrafts[card.id] ?? ""}
                        onChange={(e) => {
                          setCardNumberDrafts((drafts) => ({ ...drafts, [card.id]: e.target.value }));
                          setCardNumberEditorMessage(null);
                        }}
                        className="w-full rounded-lg bg-gray-600 px-3 py-2 text-white placeholder:text-gray-300"
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="flex justify-end gap-3 border-t border-gray-700 p-4 sm:p-6">
              <button
                type="button"
                onClick={() => setShowCardNumberEditor(false)}
                className="rounded-lg border border-gray-600 px-4 py-2 text-gray-300 hover:bg-gray-700"
              >
                {tCommon("cancel")}
              </button>
              <button
                type="button"
                onClick={saveCardNumbers}
                disabled={savingCardNumbers}
                className="rounded-lg bg-purple-600 px-4 py-2 text-white hover:bg-purple-700 disabled:opacity-50"
              >
                {savingCardNumbers ? t("cardNumberEditor.saving") : t("cardNumberEditor.save")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Sorting, filtering, and view toggle controls */}
      {/* 並び替え、フィルタリング、表示切り替えコントロール */}
      {cards.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          {/* Sorting and filtering controls */}
          {/* 並び替えとフィルタリングコントロール */}
          <div className="flex flex-wrap items-center gap-2">
            {/* Title search */}
            {/* タイトル検索 */}
            <input
              type="search"
              value={titleSearchQuery}
              onChange={(e) => setTitleSearchQuery(e.target.value)}
              placeholder={t("search.titlePlaceholder")}
              aria-label={t("search.titleLabel")}
              className="min-w-[14rem] rounded-lg border border-gray-600 bg-gray-700 px-3 py-1.5 text-sm text-white placeholder:text-gray-400"
            />

            {/* Sort field selector */}
            {/* 並び替えフィールド選択 */}
            <select
              value={sortField}
              onChange={(e) => setSortField(e.target.value as SortField)}
              className="min-w-0 appearance-none rounded-lg bg-gray-700 px-3 py-1.5 pr-8 text-sm text-white border border-gray-600"
              style={SELECT_ARROW_STYLE}
            >
              <option value="display_order">{t("sort.displayOrder")}</option>
              <option value="created_at">{t("sort.createdAt")}</option>
              <option value="rarity">{t("sort.rarity")}</option>
              <option value="card_number">{t("sort.cardNumber")}</option>
              <option value="drop_rate">{t("sort.dropRate")}</option>
            </select>

            {/* Sort direction toggle */}
            {/* 並び替え方向トグル */}
            <button
              onClick={() => setSortDirection(prev => prev === "asc" ? "desc" : "asc")}
              className="rounded-lg bg-gray-700 px-3 py-1.5 text-sm text-white border border-gray-600 hover:bg-gray-600 flex items-center gap-1"
              title={sortDirection === "asc" ? t("sort.ascending") : t("sort.descending")}
            >
              {sortDirection === "asc" ? (
                <>
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
                  </svg>
                  {t("sort.ascending")}
                </>
              ) : (
                <>
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                  {t("sort.descending")}
                </>
              )}
            </button>

            {/* Separator */}
            {/* 区切り線 */}
            <div className="h-6 w-px bg-gray-600" />

            {/* Status filter */}
            {/* ステータスフィルター */}
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
              className="min-w-0 appearance-none rounded-lg bg-gray-700 px-3 py-1.5 pr-8 text-sm text-white border border-gray-600"
              style={SELECT_ARROW_STYLE}
            >
              <option value="all">{t("filter.all")}</option>
              <option value="active">{t("filter.active")}</option>
              <option value="inactive">{t("filter.inactive")}</option>
            </select>

            {/* Pack filter (Issue #554) */}
            {/* パックフィルター */}
            <select
              value={packFilter}
              onChange={(e) => setPackFilter(e.target.value)}
              aria-label={t("filter.packLabel")}
              className="min-w-0 appearance-none rounded-lg bg-gray-700 px-3 py-1.5 pr-8 text-sm text-white border border-gray-600"
              style={SELECT_ARROW_STYLE}
            >
              <option value="">{t("filter.packAll")}</option>
              <option value={DEFAULT_PACK_SENTINEL}>
                {defaultPackName ?? t("cardPackModal.defaultName")}
              </option>
              {packFilterOptions.map((name) => (
                <option key={name} value={name}>{name}</option>
              ))}
            </select>
          </div>

          {/* View toggle (shown when showViewToggle is true) */}
          {/* ビュートグル（showViewToggleがtrueの場合に表示） */}
          {showViewToggle && (
            <CardViewToggle
              viewMode={currentViewMode}
              onViewModeChange={setCurrentViewMode}
            />
          )}
        </div>
      )}

      {/* Card List/Grid */}
      {/* カード一覧（リスト/グリッド） */}
      {(() => {
        // Apply maxCards limit if specified (for preview mode)
        // Use filteredAndSortedCards for display with sorting/filtering applied
        // maxCardsが指定されている場合は制限を適用（プレビューモード用）
        // 並び替え/フィルタリングが適用されたfilteredAndSortedCardsを表示に使用
        const displayCards = maxCards ? filteredAndSortedCards.slice(0, maxCards) : filteredAndSortedCards;

        if (cards.length === 0) {
          return (
            <p className="text-center text-gray-400">
              {t("messages.emptyCards")}
            </p>
          );
        }

        return (
          <>
            {/* Issue #565: パックフィルタ選択中は確率列が「そのパックから引いた
                場合の抽選確率」に切り替わるため、その旨を明示する。確率列は
                リスト表示にしか無いのでリスト表示時のみ出す。また、絞り込み
                結果が0件で「該当カードなし」の空状態を表示する場合は確率列
                自体が存在しないため、ヒントも出さない(displayCards.length > 0)。 */}
            {packFilter && currentViewMode === "list" && displayCards.length > 0 && (
              <p className="mb-2 text-xs text-gray-400">
                {t("filter.packProbabilityHint")}
              </p>
            )}
            {displayCards.length === 0 ? (
              <p className="rounded-lg border border-gray-700 bg-gray-800 px-4 py-8 text-center text-gray-400">
                {t("messages.noMatchingCards")}
              </p>
            ) : currentViewMode === "list" ? (
              <CardList
                cards={displayCards}
                totalActiveWeight={totalActiveWeight}
                onEdit={handleEdit}
                onDelete={handleDelete}
                onToggleActive={handleToggleActive}
                showActions={true}
                onImageClick={(card, trigger) => {
                  if (!card.image_url) return;
                  // リスト表示のサムネイルクリックでも同じ拡大モーダルを使い、閉じたらフォーカスを戻す
                  // Reuse the same zoom modal for list view so closing returns focus to the clicked thumbnail
                  zoomTriggerRef.current = trigger;
                  setZoomedImage({ url: card.image_url, name: card.name });
                }}
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
                      {/* Paused badge / 一時停止中バッジ */}
                      {isPaused && (
                        <div className="absolute top-0 left-0 right-0 bg-yellow-600 text-white text-xs text-center py-1 z-10">
                          {t("status.paused")}
                        </div>
                      )}
                      {/* 名前とレアリティを一番上に配置 */}
                      <div className={`p-3 pb-2 ${isPaused ? 'pt-8' : ''}`}>
                        <div className="flex items-center justify-between">
                          <h3 className="font-semibold text-white truncate">{card.name}</h3>
                          <span
                            className={`rounded-full px-2 py-0.5 text-xs text-white shrink-0 ml-2 ${rarityInfo.color}`}
                          >
                            {getRarityLabel(card.rarity)}
                          </span>
                        </div>
                      </div>
                      {/* 正方形画像（トリミング） */}
                      {/* 画像がある場合のみクリック可能なボタンでラップし、拡大モーダルを開く */}
                      <div className="aspect-square bg-gray-600">
                        {card.image_url ? (
                          (() => {
                            const imageUrl = card.image_url;
                            return (
                              <button
                                type="button"
                                onClick={(e) => {
                                  zoomTriggerRef.current = e.currentTarget;
                                  setZoomedImage({ url: imageUrl, name: card.name });
                                }}
                                className="block h-full w-full cursor-zoom-in overflow-hidden focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-500"
                                aria-label={t("actions.enlargeImage", { name: card.name })}
                              >
                                <Image
                                  src={getOptimizedImageUrl(imageUrl, "thumbnail")}
                                  alt={card.name}
                                  width={300}
                                  height={300}
                                  className="w-full h-full object-cover"
                                  priority={isPriority}
                                  unoptimized
                                />
                              </button>
                            );
                          })()
                        ) : (
                          <div className="flex h-full items-center justify-center text-gray-500">
                            {tCommon("noImage")}
                          </div>
                        )}
                      </div>
                      {/* 説明は画像の下（長い場合は省略してクリックで展開） */}
                      {/* Description below image (truncated if long, expandable on click) */}
                      {card.description && (
                        <div className="p-3 pt-2">
                          <ExpandableDescription description={card.description} maxLines={2} />
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
                          {isPaused ? t("actions.resumeDistribution") : t("actions.pauseDistribution")}
                        </button>
                        <button
                          onClick={() => handleEdit(card)}
                          className="rounded bg-blue-500 px-2 py-1 text-xs text-white hover:bg-blue-600"
                        >
                          {tCommon("edit")}
                        </button>
                        <button
                          onClick={() => handleDelete(card.id)}
                          className="rounded bg-red-500 px-2 py-1 text-xs text-white hover:bg-red-600"
                        >
                          {t("actions.fullDelete")}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Card count and loading status */}
            {/* カード件数と読み込み状態 */}
            <div className="mt-6 flex flex-col items-center gap-3">
              <p className="text-sm text-gray-400">
                {filteredAndSortedCards.length > 0
                  ? t("cardCount.nCards", { count: filteredAndSortedCards.length })
                  : t("cardCount.noCards")}
              </p>

              {/* Loading indicator */}
              {/* 読み込み中表示 */}
              {loading && (
                <div className="flex items-center gap-2 text-gray-400">
                  <svg className="h-5 w-5 animate-spin" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                  </svg>
                  <span>{tCommon("loading")}</span>
                </div>
              )}
            </div>
          </>
        );
      })()}

      {/* Drop Rate Info Modal */}
      {/* 出現確率説明モーダル */}
      {showDropRateInfo && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70" onClick={() => setShowDropRateInfo(false)}>
          <div className="mx-4 max-w-lg rounded-xl bg-gray-800 p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-lg font-semibold text-white">{t("dropRateInfo.title")}</h3>
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
                {t("dropRateInfo.description1")}
              </p>
              <div className="rounded-lg bg-gray-700 p-4">
                <p className="mb-2 text-sm text-gray-400">{t("dropRateInfo.formula")}</p>
                <p className="font-mono text-sm text-white">
                  {t("dropRateInfo.formulaText")}
                </p>
              </div>
              <div className="rounded-lg bg-gray-700 p-4">
                <p className="mb-2 text-sm text-gray-400">{t("dropRateInfo.example")}</p>
                <ul className="space-y-1 text-sm">
                  <li>• {t("dropRateInfo.example1")}</li>
                  <li className="text-green-400">{t("dropRateInfo.example1Result")}</li>
                </ul>
                <ul className="mt-2 space-y-1 text-sm">
                  <li>• {t("dropRateInfo.example2")}</li>
                  <li className="text-green-400">{t("dropRateInfo.example2Result")}</li>
                </ul>
              </div>
              <p className="text-sm text-gray-400">
                {t("dropRateInfo.note")}
              </p>
            </div>
            <button
              onClick={() => setShowDropRateInfo(false)}
              className="mt-6 w-full rounded-lg bg-purple-600 py-2 text-white hover:bg-purple-700"
            >
              {t("dropRateInfo.close")}
            </button>
          </div>
        </div>
      )}

      {/* Crop Mode Selection Modal */}
      {/* トリミングモード選択モーダル */}
      {cropModeModalOpen && selectedFileForCrop && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
          <div className="w-full max-w-md rounded-xl bg-gray-800 shadow-2xl">
            {/* Modal header */}
            {/* モーダルヘッダー */}
            <div className="flex items-center justify-between border-b border-gray-700 p-4">
              <h3 className="text-lg font-semibold text-white">
                {t("form.selectCropMode")}
              </h3>
              <button
                type="button"
                onClick={handleCropModeCancel}
                className="text-gray-400 hover:text-white"
                aria-label={tCommon("cancel")}
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Crop mode options */}
            {/* トリミングモードオプション */}
            <div className="p-4 space-y-3">
              <p className="text-sm text-gray-400 mb-4">
                {t("form.cropModeDescription")}
              </p>

              {/* Resolution selector - only shown when multiple selectable widths available */}
              {/* 解像度セレクター - 画像サイズ以下の選択肢が複数ある場合のみ表示 */}
              {effectiveWidths.length > 1 && (
                <div className="mb-4">
                  <p className="text-sm text-gray-300 mb-2">{t("form.selectResolution")}</p>
                  <div className="flex gap-2">
                    {effectiveWidths.map((w) => (
                      <button
                        key={w}
                        type="button"
                        onClick={() => setSelectedWidth(w)}
                        className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium transition ${
                          selectedWidth === w
                            ? "bg-purple-600 text-white"
                            : "bg-gray-700 text-gray-300 hover:bg-gray-600"
                        }`}
                      >
                        {w === 800 ? t("form.resolutionStandard") : w === 1920 ? t("form.resolutionFullHd") : t("form.resolution4k")}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Square option */}
              {/* 正方形オプション */}
              <button
                type="button"
                onClick={() => handleCropModeSelect("square")}
                className="w-full flex items-center gap-4 p-4 rounded-lg bg-gray-700 hover:bg-gray-600 border-2 border-transparent hover:border-purple-500 transition"
              >
                <div className="w-12 h-12 bg-purple-600 rounded flex items-center justify-center shrink-0">
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4h16v16H4z" />
                  </svg>
                </div>
                <div className="text-left">
                  <p className="font-medium text-white">{planCropModes.square.label}</p>
                  <p className="text-sm text-gray-400">{planCropModes.square.dimensions}px (JPEG)</p>
                </div>
              </button>

              {/* Portrait option */}
              {/* ポートレイトオプション */}
              <button
                type="button"
                onClick={() => handleCropModeSelect("portrait")}
                className="w-full flex items-center gap-4 p-4 rounded-lg bg-gray-700 hover:bg-gray-600 border-2 border-transparent hover:border-purple-500 transition"
              >
                <div className="w-12 h-12 bg-purple-600 rounded flex items-center justify-center shrink-0">
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-8 w-6 text-white" fill="none" viewBox="0 0 24 32" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4h16v24H4z" />
                  </svg>
                </div>
                <div className="text-left">
                  <p className="font-medium text-white">{planCropModes.portrait.label}</p>
                  <p className="text-sm text-gray-400">{planCropModes.portrait.dimensions}px (JPEG)</p>
                </div>
              </button>
            </div>

            {/* Cancel button */}
            {/* キャンセルボタン */}
            <div className="flex justify-end border-t border-gray-700 p-4">
              <button
                type="button"
                onClick={handleCropModeCancel}
                className="rounded-lg border border-gray-600 px-6 py-2 text-gray-300 hover:bg-gray-700"
              >
                {tCommon("cancel")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Image Cropper Modal */}
      {/* 画像トリミングモーダル */}
      {cropModalOpen && selectedFileForCrop && (
        <ImageCropper
          imageFile={selectedFileForCrop}
          cropMode={selectedCropMode}
          onCropComplete={handleCropComplete}
          onCancel={handleCropCancel}
          maxWidth={selectedWidth}
        />
      )}

      {/* Drop Rate Settings Modal */}
      {/* カード排出確率設定モーダル */}
      <DropRateSettingsModal
        isOpen={showBatchDropRateModal}
        onClose={() => setShowBatchDropRateModal(false)}
        cards={cards}
        streamerId={streamerId}
        onCardsSave={handleBatchDropRateSave}
        onRarityWeightsApply={handleRarityWeightsApply}
        rarityWeights={rarityWeights}
        customRarities={customRarities}
      />

      {/* Custom Rarity Modal */}
      {/* カスタムレアリティ管理モーダル */}
      <CustomRarityModal
        isOpen={showCustomRarityModal}
        onClose={() => setShowCustomRarityModal(false)}
        streamerId={streamerId}
        customRarities={customRarities}
        onSaved={setCustomRarities}
      />

      {/* Card Pack Modal (Issue #393再設計) */}
      {/* パック管理モーダル */}
      <CardPackModal
        isOpen={showCardPackModal}
        onClose={() => setShowCardPackModal(false)}
        streamerId={streamerId}
        cardPackNames={cardPackNames}
        defaultPackName={defaultPackName}
        isPremium={isPremium}
        onSaved={setCardPackNames}
        onDefaultPackNameSaved={setDefaultPackName}
      />

      {/* Emote Import Modal */}
      {/* エモートインポートモーダル */}
      {showEmoteModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={() => setShowEmoteModal(false)}>
          <div className="max-h-[90vh] w-full max-w-4xl overflow-hidden rounded-xl bg-gray-800 shadow-2xl flex flex-col" onClick={(e) => e.stopPropagation()}>
            {/* Modal Header */}
            {/* モーダルヘッダー */}
            <div className="p-6 border-b border-gray-700">
              <div className="flex items-center justify-between">
                <h3 className="text-lg font-semibold text-white">{t("emoteImport.title")}</h3>
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
                {t("emoteImport.description")}
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
                  <div className="text-gray-400">{t("emoteImport.loading")}</div>
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
                        t("emoteImport.allExisting")
                      ) : (
                        <>
                          {t("emoteImport.selected", { selected: selectedEmotes.size, total: getAvailableEmotes().length })}
                          {emotes.length !== getAvailableEmotes().length && (
                            <span className="ml-2 text-yellow-400">
                              {t("emoteImport.duplicates", { count: emotes.length - getAvailableEmotes().length })}
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
                        {t("emoteImport.selectAll")}
                      </button>
                      <span className="text-gray-600">|</span>
                      <button
                        onClick={deselectAllEmotes}
                        className="text-sm text-purple-400 hover:text-purple-300"
                      >
                        {t("emoteImport.deselectAll")}
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
                          title={isExisting ? t("emoteImport.alreadyExists") : emote.name}
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
                                {t("emoteImport.created")}
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
                  {t("emoteImport.noEmotes")}
                  <br />
                  {t("emoteImport.requiresAffiliate")}
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
                  <label className="block text-sm text-gray-400 mb-1">{t("emoteImport.defaultRarity")}</label>
                  <select
                    value={emoteDefaultRarity}
                    onChange={(e) => setEmoteDefaultRarity(e.target.value as Rarity)}
                    className="w-full appearance-none rounded-lg bg-gray-700 px-3 py-2 pr-10 text-white text-sm"
                    style={SELECT_ARROW_STYLE}
                  >
                    {RARITIES.map((r) => (
                      <option key={r.value} value={r.value}>
                        {tRarity(r.value)}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-sm text-gray-400 mb-1">
                    {t("emoteImport.defaultWeight", { weight: (emoteDefaultDropRate * 100).toFixed(0) })}
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
                  {tCommon("cancel")}
                </button>
                <button
                  onClick={createCardsFromEmotes}
                  disabled={selectedEmotes.size === 0 || creatingCards}
                  className="rounded-lg bg-purple-600 px-4 py-2 text-white hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {creatingCards ? t("buttons.creating") : t("emoteImport.createCards", { count: selectedEmotes.size })}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Zoomed image modal - full-size preview triggered from thumbnail click */}
      {/* 拡大画像モーダル - サムネイルクリックで大きな画像を表示 */}
      {zoomedImage && (() => {
        const closeZoom = () => {
          setZoomedImage(null);
          // モーダルを閉じたら元のサムネイルボタンへフォーカスを戻す（アクセシビリティ）
          // Return focus to the originating thumbnail button for keyboard users
          const trigger = zoomTriggerRef.current;
          zoomTriggerRef.current = null;
          if (trigger) {
            // requestAnimationFrame: 再レンダリング後にフォーカスを戻す
            requestAnimationFrame(() => trigger.focus());
          }
        };
        return (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
            onClick={closeZoom}
            role="dialog"
            aria-modal="true"
            aria-label={t("actions.enlargedImage")}
          >
            <div className="relative max-h-full max-w-5xl" onClick={(e) => e.stopPropagation()}>
              {/* CF Images Transformations の large プリセットで帯域最適化しつつ、object-contain でアスペクト比を維持 */}
              {/* Use the CF Images 'large' preset to limit bandwidth; object-contain preserves the original aspect ratio */}
              <Image
                src={getOptimizedImageUrl(zoomedImage.url, "large")}
                alt={zoomedImage.name}
                width={1200}
                height={1200}
                className="h-auto max-h-[90vh] w-auto max-w-full object-contain"
                unoptimized
                priority
              />
              <button
                type="button"
                onClick={closeZoom}
                autoFocus
                className="absolute -top-3 -right-3 rounded-full bg-gray-800 p-2 text-white shadow-lg hover:bg-gray-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-500"
                aria-label={t("actions.closeImage")}
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
