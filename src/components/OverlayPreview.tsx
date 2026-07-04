"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { useTranslations } from "next-intl";
import CopyButton from "@/components/CopyButton";
import type { Card } from "@/types/database";
import { RARITIES } from "@/lib/constants";
import {
  type OverlayEffectStyle,
  type RarityEffectMap,
  OVERLAY_EFFECT_STYLES,
  DEFAULT_BUILTIN_RARITY_EFFECTS,
  isOverlayEffectStyle,
  normalizeOverlayEffectStyle,
  serializeRarityEffectMap,
} from "@/lib/overlay-effect";

/** 設定 UI で個別にエフェクトを割り当てられるビルトインレアリティ */
type BuiltinRarity = (typeof RARITIES)[number]["value"];
// RARITIES（constants）から派生させ、レアリティ値リストの二重管理を避ける。
const BUILTIN_RARITIES: readonly BuiltinRarity[] = RARITIES.map((rarity) => rarity.value);
/** レアリティ→エフェクトの割り当て（UI 状態） */
type RarityEffects = Record<BuiltinRarity, OverlayEffectStyle>;

/**
 * Overlay preview options interface
 * オーバーレイプレビューのオプション設定インターフェース
 */
interface OverlayOptions {
  imageOnly: boolean;       // 画像のみ表示（カード枠なし）
  autoPortrait: boolean;    // 縦長画像を自動検出してオリジナル表示
  effects: boolean;         // エフェクト表示のマスタースイッチ
  rarityEffects: RarityEffects; // レアリティ別のエフェクト種類
  smallMode: boolean;       // 小さい画像用の縮小表示モード
  displayDuration: number;  // カードの表示時間（秒）、デフォルト6秒
  // 縦長画像の付帯情報表示オプション（画像に被らず下に表示）
  // Portrait image info options (displayed below image, not overlapping)
  portraitShowName: boolean;        // 縦長画像でカード名を表示
  portraitShowRarity: boolean;      // 縦長画像でレアリティを表示
  portraitShowDescription: boolean; // 縦長画像で説明を表示
  portraitShowUsername: boolean;    // 縦長画像でユーザー名を表示
}

const DEFAULT_OVERLAY_OPTIONS: OverlayOptions = {
  imageOnly: false,
  autoPortrait: true,
  effects: true,
  rarityEffects: { ...DEFAULT_BUILTIN_RARITY_EFFECTS },
  smallMode: true,
  displayDuration: 6,
  portraitShowName: false,
  portraitShowRarity: true,
  portraitShowDescription: false,
  portraitShowUsername: false,
};

const OVERLAY_OPTIONS_STORAGE_KEY_PREFIX = "twica:overlay-options:";

/**
 * Issue #532: オプション変更はiframeのURLに正しく反映されていたが、オーバーレイは
 * カード非表示中は透明な背景のみのため、変更してもユーザーが見た目の変化に
 * 気づけないUX問題があった。デモ実行直後の一定時間内にオプションを変更した場合は
 * 自動でプレビューDEMOを再実行し、変更が視覚的にすぐ確認できるようにする。
 *
 * この時間を超えた変更では自動発火しない（無関係なタイミングでカードが
 * 勝手に出るのを防ぐ）。
 */
const RECENT_DEMO_WINDOW_MS = 30_000;
/** スライダー操作等の連続的なオプション変更を1回の再デモにまとめるデバウンス時間 */
const AUTO_REDEMO_DEBOUNCE_MS = 800;

function readStoredBoolean(value: unknown, fallback: boolean) {
  return typeof value === "boolean" ? value : fallback;
}

/**
 * 保存済み設定からレアリティ別エフェクトを復元する。
 * - 新形式 rarityEffects（レアリティ→スタイル）があればそれを正規化して使う。
 * - 旧形式（単一 effectStyle）しか無い場合は「legendary のみその値、他は none」へ
 *   移行する（従来はエフェクトが legendary にのみ表示されていたため、配信者の
 *   以前の選択を legendary の演出として引き継ぐ）。
 */
function readStoredRarityEffects(stored: Partial<Record<string, unknown>>): RarityEffects {
  const raw = stored.rarityEffects;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const source = raw as Record<string, unknown>;
    const result = { ...DEFAULT_BUILTIN_RARITY_EFFECTS };
    for (const rarity of BUILTIN_RARITIES) {
      // 不正な値（未知スタイル）はそのレアリティの既定値のまま据え置く。
      // normalizeOverlayEffectStyle で sparkle に丸めてしまうと、保存データが
      // 破損しただけで「割り当てていないレアリティに演出が出る」誤爆になる
      // （deserializeRarityEffectMap が未知スタイルをスキップするのと同じ方針）。
      const value = source[rarity];
      if (isOverlayEffectStyle(value)) {
        result[rarity] = value;
      }
    }
    return result;
  }

  if (typeof stored.effectStyle === "string") {
    return {
      ...DEFAULT_BUILTIN_RARITY_EFFECTS,
      legendary: normalizeOverlayEffectStyle(stored.effectStyle),
    };
  }

  return { ...DEFAULT_BUILTIN_RARITY_EFFECTS };
}

function clampDisplayDuration(value: unknown) {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_OVERLAY_OPTIONS.displayDuration;
  }
  return Math.min(15, Math.max(2, parsed));
}

function parseStoredOptions(value: unknown): OverlayOptions {
  if (!value || typeof value !== "object") {
    return { ...DEFAULT_OVERLAY_OPTIONS };
  }

  const stored = value as Partial<Record<keyof OverlayOptions, unknown>>;

  return {
    imageOnly: readStoredBoolean(stored.imageOnly, DEFAULT_OVERLAY_OPTIONS.imageOnly),
    autoPortrait: readStoredBoolean(stored.autoPortrait, DEFAULT_OVERLAY_OPTIONS.autoPortrait),
    effects: readStoredBoolean(stored.effects, DEFAULT_OVERLAY_OPTIONS.effects),
    rarityEffects: readStoredRarityEffects(stored),
    smallMode: readStoredBoolean(stored.smallMode, DEFAULT_OVERLAY_OPTIONS.smallMode),
    displayDuration: clampDisplayDuration(stored.displayDuration),
    portraitShowName: readStoredBoolean(stored.portraitShowName, DEFAULT_OVERLAY_OPTIONS.portraitShowName),
    portraitShowRarity: readStoredBoolean(stored.portraitShowRarity, DEFAULT_OVERLAY_OPTIONS.portraitShowRarity),
    portraitShowDescription: readStoredBoolean(stored.portraitShowDescription, DEFAULT_OVERLAY_OPTIONS.portraitShowDescription),
    portraitShowUsername: readStoredBoolean(stored.portraitShowUsername, DEFAULT_OVERLAY_OPTIONS.portraitShowUsername),
  };
}

function areRarityEffectsEqual(a: RarityEffects, b: RarityEffects) {
  return BUILTIN_RARITIES.every((rarity) => a[rarity] === b[rarity]);
}

/** レアリティ別エフェクトが既定（legendary のみ sparkle）と一致するか */
function isDefaultRarityEffects(value: RarityEffects) {
  return areRarityEffectsEqual(value, DEFAULT_BUILTIN_RARITY_EFFECTS);
}

function areOverlayOptionsEqual(a: OverlayOptions, b: OverlayOptions) {
  return (
    a.imageOnly === b.imageOnly &&
    a.autoPortrait === b.autoPortrait &&
    a.effects === b.effects &&
    areRarityEffectsEqual(a.rarityEffects, b.rarityEffects) &&
    a.smallMode === b.smallMode &&
    a.displayDuration === b.displayDuration &&
    a.portraitShowName === b.portraitShowName &&
    a.portraitShowRarity === b.portraitShowRarity &&
    a.portraitShowDescription === b.portraitShowDescription &&
    a.portraitShowUsername === b.portraitShowUsername
  );
}

interface OverlayPreviewProps {
  streamerId: string;
  baseUrl: string;
  showPreview?: boolean;  // プレビューセクションを表示するかどうか（デフォルト: true）
  showCustomization?: boolean;  // カスタマイズ折りたたみセクションを表示するか（デフォルト: true）
  showCollectionUrl?: boolean;  // コレクションURLセクションを表示するか（デフォルト: true）
  sideContent?: React.ReactNode;  // URLセクションの横に表示するコンテンツ（横並びレイアウト用）
  cards?: Card[];  // デバッグ用：配信者のカード一覧（セレクトボックスで選択可能）
}

/**
 * Vercelプレビュー環境かどうかを判定
 * NEXT_PUBLIC_VERCEL_ENVはVercelが自動的に設定する環境変数
 * "preview" = プレビューデプロイ、"production" = 本番、"development" = ローカル開発
 * Check if running in Vercel preview environment
 */
const isPreviewEnvironment = process.env.NEXT_PUBLIC_VERCEL_ENV === "preview";

/**
 * Overlay Preview Component
 * オーバーレイ設定のプレビューコンポーネント
 * - OBSブラウザソースURLの表示（オプション変更で自動更新）
 * - URLパラメータオプションの設定
 * - iframeでのプレビュー表示
 * - DEMOボタンで配信者のカードを表示
 */
export default function OverlayPreview({
  streamerId,
  baseUrl,
  showPreview = true,
  showCustomization = true,
  showCollectionUrl = true,
  sideContent,
  cards = [],
}: OverlayPreviewProps) {
  const t = useTranslations("overlaySettings");
  const tDashboard = useTranslations("dashboard");
  const tRarity = useTranslations("rarity");
  const storageKey = `${OVERLAY_OPTIONS_STORAGE_KEY_PREFIX}${streamerId}`;

  // オーバーレイオプションの状態管理
  // autoPortraitとsmallModeはデフォルトでtrue（より良い表示体験のため）
  const [options, setOptions] = useState<OverlayOptions>(() => ({ ...DEFAULT_OVERLAY_OPTIONS }));
  const [initializedStorageKey, setInitializedStorageKey] = useState<string | null>(null);

  // URL更新メッセージの表示状態
  const [showUrlUpdated, setShowUrlUpdated] = useState(false);
  // 初回レンダリングフラグ（初回は更新メッセージを表示しない）
  const isFirstRender = useRef(true);

  // iframeの参照（DEMOボタン用）
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // Issue #532: 直近にプレビューDEMOを実行した時刻（自動再デモの判定に使用）
  // null の場合はまだ一度もデモを実行していないことを表す。
  // 初回表示やOBS URLをコピーしただけの利用では勝手にカードを出さないためのガードとして使う。
  const lastDemoAtRef = useRef<number | null>(null);
  // 自動再デモのデバウンス用タイマーID
  const autoRedemoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // オプション変更の初回検知フラグ（URL更新メッセージ用のisFirstRenderとは別管理）
  const isFirstOptionsChange = useRef(true);

  // デバッグ用：選択されたカードID（"random"でランダム、カードIDで特定のカード）
  // Debug: selected card ID for demo/gacha ("random" for random selection, card ID for specific card)
  const [selectedCardId, setSelectedCardId] = useState<string>("random");

  // 実行中状態の管理（重複実行防止）
  const [isExecuting, setIsExecuting] = useState(false);

  // OBS DEMOの実行中状態
  // OBS Demo execution state
  const [isObsDemoExecuting, setIsObsDemoExecuting] = useState(false);

  // デモヘルプモーダルの表示状態
  // Demo help modal visibility state
  const [showDemoHelp, setShowDemoHelp] = useState(false);

  // オーバーレイカスタマイズセクションの折りたたみ状態
  // Collapsible state for overlay customization section
  const [isCustomizationExpanded, setIsCustomizationExpanded] = useState(false);

  useEffect(() => {
    isFirstRender.current = true;
    setShowUrlUpdated(false);
    // 配信者切り替え（storageKey変更）時は直近デモ状態も引き継がずリセットする
    isFirstOptionsChange.current = true;
    lastDemoAtRef.current = null;
    if (autoRedemoTimerRef.current) {
      clearTimeout(autoRedemoTimerRef.current);
      autoRedemoTimerRef.current = null;
    }
  }, [storageKey]);

  // ブラウザごとに最後に使ったオーバーレイ設定を復元する
  // Restore the last-used overlay settings for this browser and streamer
  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    try {
      const storedOptions = window.localStorage.getItem(storageKey);
      const nextOptions = storedOptions
        ? parseStoredOptions(JSON.parse(storedOptions))
        : { ...DEFAULT_OVERLAY_OPTIONS };

      setOptions((currentOptions) => (
        areOverlayOptionsEqual(currentOptions, nextOptions) ? currentOptions : nextOptions
      ));
    } catch (error) {
      console.error("Failed to restore overlay options:", error);
      try {
        window.localStorage.removeItem(storageKey);
      } catch {
        // localStorage自体が使えない環境では何もしない
      }
      setOptions((currentOptions) => (
        areOverlayOptionsEqual(currentOptions, DEFAULT_OVERLAY_OPTIONS)
          ? currentOptions
          : { ...DEFAULT_OVERLAY_OPTIONS }
      ));
    } finally {
      setInitializedStorageKey(storageKey);
    }
  }, [storageKey]);

  // オプション変更を自動保存する
  // Persist overlay options automatically after initialization
  useEffect(() => {
    if (initializedStorageKey !== storageKey || typeof window === "undefined") {
      return;
    }

    try {
      window.localStorage.setItem(storageKey, JSON.stringify(options));
    } catch (error) {
      console.error("Failed to persist overlay options:", error);
    }
  }, [initializedStorageKey, options, storageKey]);

  // 現在のオプションからURLパラメータを生成（ユーザー向けURL用）
  // Generate URL parameters from current options (for user-facing URL)
  // autoPortrait, smallMode, effectsはデフォルトでtrue（falseの場合のみURLパラメータで明示）
  // portraitShowRarityはデフォルトでtrue、それ以外はfalse
  const buildUrlParams = useCallback(() => {
    const params = new URLSearchParams();
    if (options.imageOnly) params.set("imageOnly", "true");
    if (!options.autoPortrait) params.set("autoPortrait", "false");  // デフォルトtrue、falseの場合のみ出力
    if (!options.effects) params.set("effects", "false");             // デフォルトtrue、falseの場合のみ出力
    // レアリティ別エフェクトの符号化。既定（legendary のみ sparkle）のままなら
    // URL をクリーンに保つため何も出力しない。effects=false のときは全レアリティ
    // 無効なので出力しない。
    // - legendary だけに演出を割り当てた一般的なケースは、可読性と後方互換のため
    //   レガシー `effect=` 形式で出力する（旧オーバーレイURLもこの形式を解釈する）。
    //   ※このケースは serializeRarityEffectMap を通さず effect= に直接載せる近道。
    // - 複数レアリティに割り当てた場合のみ新形式 `fx=`（serializeRarityEffectMap）を使う。
    // overlay page 側の parseRarityEffectMap が両形式を解釈する（fx 優先、なければ effect）。
    if (options.effects && !isDefaultRarityEffects(options.rarityEffects)) {
      const re = options.rarityEffects;
      const onlyLegendaryHasEffect =
        re.common === "none" && re.rare === "none" && re.epic === "none" && re.legendary !== "none";
      if (onlyLegendaryHasEffect) {
        params.set("effect", re.legendary);
      } else {
        params.set("fx", serializeRarityEffectMap(re as RarityEffectMap));
      }
    }
    if (!options.smallMode) params.set("smallMode", "false");        // デフォルトtrue、falseの場合のみ出力
    // カードの表示時間（デフォルト6秒、それ以外の場合のみ出力）
    // Display duration in seconds (default 6, only output if different)
    if (options.displayDuration !== 6) params.set("duration", String(options.displayDuration));
    // 縦長画像の付帯情報オプション
    // Portrait info options
    if (options.portraitShowName) params.set("pName", "true");               // デフォルトfalse、trueの場合のみ出力
    if (!options.portraitShowRarity) params.set("pRarity", "false");         // デフォルトtrue、falseの場合のみ出力
    if (options.portraitShowDescription) params.set("pDesc", "true");        // デフォルトfalse、trueの場合のみ出力
    if (options.portraitShowUsername) params.set("pUser", "true");           // デフォルトfalse、trueの場合のみ出力
    return params.toString();
  }, [options]);

  // オーバーレイURLを生成
  const overlayUrl = `${baseUrl}/overlay/${streamerId}`;
  const urlParams = buildUrlParams();
  const overlayUrlWithParams = urlParams ? `${overlayUrl}?${urlParams}` : overlayUrl;

  // コレクションページURLを生成
  // Generate collection page URL
  const collectionUrl = `${baseUrl}/collection/${streamerId}`;

  // オプション変更時にURL更新メッセージを表示
  // 初回レンダリング時は表示しない
  // queueMicrotaskを使用してsetStateを非同期に実行し、カスケードレンダーを回避
  useEffect(() => {
    if (initializedStorageKey !== storageKey) {
      return;
    }
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    // 非同期に実行してuseEffect内での同期的なsetState呼び出しを回避
    // Defer setState to avoid synchronous state update in effect body
    queueMicrotask(() => {
      setShowUrlUpdated(true);
    });
    // 3秒後に非表示
    const timer = setTimeout(() => {
      setShowUrlUpdated(false);
    }, 3000);
    return () => clearTimeout(timer);
  }, [initializedStorageKey, options, storageKey]);

  // プレビューDEMOを実行（iframe内のオーバーレイにメッセージを送信）
  // 選択されたカードID（またはランダム）でデモを実行
  // Trigger preview demo in iframe by refreshing with demo param and optional cardId
  const triggerDemo = useCallback(() => {
    if (iframeRef.current) {
      // iframeをリロードしてdemoパラメータ付きで再読み込み
      // カードIDも指定（"random"の場合はランダム選択）
      let demoUrl = urlParams ? `${overlayUrl}?${urlParams}&demo=true` : `${overlayUrl}?demo=true`;
      if (selectedCardId && selectedCardId !== "random") {
        demoUrl += `&cardId=${selectedCardId}`;
      }
      iframeRef.current.src = demoUrl;
      // Issue #532: 自動再デモの起点として実行時刻を記録する
      lastDemoAtRef.current = Date.now();
    }
  }, [overlayUrl, urlParams, selectedCardId]);

  // triggerDemoの最新版を常に参照できるようにするref。
  // 自動再デモのuseEffectはselectedCardId変更（triggerDemoの依存の一つ）では
  // 再発火させたくない（対象はあくまで「表示オプション」の変更のため）ので、
  // 関数そのものをeffectの依存に含めず、refで最新のクロージャを参照する。
  const triggerDemoRef = useRef(triggerDemo);
  useEffect(() => {
    triggerDemoRef.current = triggerDemo;
  }, [triggerDemo]);

  // Issue #532: デモ実行後にオプションを変更した場合、iframeのURL自体は
  // 正しく更新されていても、カードが表示されていないアイドル状態では見た目が
  // 変わらずユーザーが変化に気づけない。直近にプレビューDEMOを実行していた
  // 場合のみ、オプション変更をデバウンスして自動的にプレビューDEMOを再実行する。
  // - デモを一度も実行していない場合（初回表示・OBS URLコピーのみの利用等）は発火しない
  // - 直近のデモから RECENT_DEMO_WINDOW_MS を超えている場合も発火しない（無関係な変更で
  //   勝手にカードが出るのを防ぐ）
  // - urlParams は options の全フィールドを反映して生成されるため、これを監視すれば
  //   表示に影響するオプション変更を過不足なく検知できる
  useEffect(() => {
    if (initializedStorageKey !== storageKey) {
      return;
    }
    if (isFirstOptionsChange.current) {
      isFirstOptionsChange.current = false;
      return;
    }
    if (lastDemoAtRef.current === null || Date.now() - lastDemoAtRef.current > RECENT_DEMO_WINDOW_MS) {
      return;
    }
    if (autoRedemoTimerRef.current) {
      clearTimeout(autoRedemoTimerRef.current);
    }
    autoRedemoTimerRef.current = setTimeout(() => {
      triggerDemoRef.current();
    }, AUTO_REDEMO_DEBOUNCE_MS);
    return () => {
      if (autoRedemoTimerRef.current) {
        clearTimeout(autoRedemoTimerRef.current);
      }
    };
    // triggerDemoRef経由で最新のtriggerDemoを参照するため、triggerDemo自体をこのeffectの
    // 依存に含める必要はない（含めるとselectedCardId変更だけでも誤発火してしまう）。
  }, [initializedStorageKey, storageKey, urlParams]);

  // OBS DEMOを実行（Supabase Realtimeでブロードキャスト）
  // OBSに設定したオーバーレイにも反映される
  // Trigger OBS demo via Supabase Realtime broadcast
  const triggerObsDemo = useCallback(async () => {
    if (isObsDemoExecuting) return;

    setIsObsDemoExecuting(true);
    try {
      await fetch("/api/gacha/demo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          streamerId,
          cardId: selectedCardId !== "random" ? selectedCardId : undefined,
          broadcast: true,
        }),
      });
    } catch (error) {
      console.error("Failed to trigger OBS demo:", error);
    } finally {
      setIsObsDemoExecuting(false);
    }
  }, [streamerId, selectedCardId, isObsDemoExecuting]);

  // 実際にガチャを引く（DBに記録される本番のガチャAPI呼び出し）
  // Execute real gacha (calls production gacha API and records to DB)
  // CSRFトークンはhttpOnly Cookieパターンで自動的にサーバーに送信される
  // CSRF token is automatically sent via httpOnly cookie pattern
  const triggerRealGacha = useCallback(async () => {
    if (isExecuting) return;

    setIsExecuting(true);
    try {
      // 本番のガチャAPIを呼び出し
      // CSRFトークンはCookieから自動的に検証される（httpOnly Cookie Pattern）
      // CSRF token is automatically validated from cookie (httpOnly Cookie Pattern)
      const response = await fetch("/api/gacha", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ streamerId }),
        credentials: "include",  // Cookieを含めて送信
      });

      if (response.ok) {
        // ガチャ成功時はリアルタイム通知でオーバーレイに表示される
        // On success, result is displayed via real-time notification to overlay
      } else {
        const errorData = await response.json();
        console.error("Gacha API error:", errorData);
        alert(`ガチャ実行エラー: ${errorData.error || "Unknown error"}`);
      }
    } catch (error) {
      console.error("Failed to execute gacha:", error);
      alert("ガチャ実行に失敗しました");
    } finally {
      setIsExecuting(false);
    }
  }, [streamerId, isExecuting]);

  // オプションの切り替え
  const toggleOption = (key: keyof OverlayOptions) => {
    setOptions(prev => ({
      ...prev,
      [key]: !prev[key],
    }));
  };

  // アクティブなカードのみフィルタリング（デモ/ガチャで使用）
  // Filter only active cards for demo/gacha
  const activeCards = cards.filter(card => card.is_active);

  // レアリティ別にエフェクトを割り当てる。エフェクトはそのレアリティのカードに
  // のみ表示されるため、変更したレアリティのカードが存在すればプレビュー用カードを
  // 自動的にそちらへ寄せ、変更結果をすぐ確認できるようにする（Issue #532 の踏襲）。
  // 該当レアリティのカードが無い場合は選択を変更しない（存在しないカードを捏造しない）。
  const handleRarityEffectChange = (rarity: BuiltinRarity, value: string) => {
    setOptions(prev => ({
      ...prev,
      rarityEffects: {
        ...prev.rarityEffects,
        [rarity]: normalizeOverlayEffectStyle(value),
      },
    }));

    const matchingCard = activeCards.find((card) => card.rarity === rarity);
    if (matchingCard) {
      setSelectedCardId(matchingCard.id);
    }
  };

  // URLセクションのコンテンツ
  // URL section content - separated for flexible layout
  const urlSection = (
    <div className="rounded-xl bg-gray-800 p-6 h-full">
      <h2 className="mb-4 text-xl font-semibold text-white">
        {tDashboard("obsOverlayUrl")}
      </h2>
      <p className="mb-4 text-sm text-gray-400">
        {tDashboard("obsOverlayDescription")}
      </p>

      {/* URL入力フィールド */}
      <div className="flex gap-2">
        <input
          type="text"
          readOnly
          value={overlayUrlWithParams}
          className="flex-1 rounded-lg bg-gray-700 px-4 py-2 text-gray-200"
        />
        <CopyButton text={overlayUrlWithParams} />
      </div>

      {/* URL更新メッセージ - 高さを常に確保してレイアウトシフトを防ぐ */}
      {/* Use fixed height and opacity transition to prevent layout shift */}
      <p
        className={`mt-2 h-5 text-sm text-green-400 transition-opacity duration-300 ${
          showUrlUpdated ? "opacity-100" : "opacity-0"
        }`}
      >
        {t("urlUpdated")}
      </p>

      {/* オーバーレイカスタマイズオプション（折りたたみ可能） */}
      {/* Overlay customization options (collapsible section) */}
      {showCustomization && (
      <div className="mt-6 pt-6 border-t border-gray-700">
        {/* 折りたたみヘッダー - クリックで展開/折りたたみ */}
        {/* Collapsible header - click to expand/collapse */}
        <button
          type="button"
          onClick={() => setIsCustomizationExpanded(!isCustomizationExpanded)}
          className="w-full flex items-center justify-between text-left cursor-pointer hover:bg-gray-700/30 rounded-lg p-2 -m-2 transition-colors"
        >
          <h3 className="text-lg font-semibold text-white">
            {t("title")}
          </h3>
          {/* 折りたたみ矢印アイコン - 展開時は下向き、折りたたみ時は右向き */}
          {/* Chevron icon - points down when expanded, right when collapsed */}
          <svg
            className={`w-5 h-5 text-gray-400 transition-transform duration-200 ${
              isCustomizationExpanded ? "rotate-180" : ""
            }`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>

        {/* 折りたたみ可能なコンテンツ部分 */}
        {/* Collapsible content section */}
        {isCustomizationExpanded && (
          <>
        <p className="text-sm text-gray-400 mb-4 mt-3">
          {t("description")}
        </p>
        <p className="text-xs text-gray-500 mb-4">
          {t("autoSaved")}
        </p>

        <div className="space-y-3">
          {/* imageOnly option */}
          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={options.imageOnly}
              onChange={() => toggleOption("imageOnly")}
              className="h-4 w-4 rounded border-gray-600 bg-gray-700 text-purple-600 focus:ring-purple-500"
            />
            <div>
              <span className="text-white">{t("options.imageOnly")}</span>
              <p className="text-xs text-gray-400">{t("options.imageOnlyDescription")}</p>
            </div>
          </label>

          {/* autoPortrait option */}
          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={options.autoPortrait}
              onChange={() => toggleOption("autoPortrait")}
              className="h-4 w-4 rounded border-gray-600 bg-gray-700 text-purple-600 focus:ring-purple-500"
            />
            <div>
              <span className="text-white">{t("options.autoPortrait")}</span>
              <p className="text-xs text-gray-400">{t("options.autoPortraitDescription")}</p>
            </div>
          </label>

          {/* effects option */}
          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={options.effects}
              onChange={() => toggleOption("effects")}
              className="h-4 w-4 rounded border-gray-600 bg-gray-700 text-purple-600 focus:ring-purple-500"
            />
            <div>
              <span className="text-white">{t("options.effects")}</span>
              <p className="text-xs text-gray-400">{t("options.effectsDescription")}</p>
            </div>
          </label>

          {/* レアリティ別エフェクト割り当て */}
          {/* Per-rarity effect assignment: each rarity can be bound to a distinct effect. */}
          {options.effects && (
            <div className="pt-1">
              <span className="mb-1 block text-sm text-gray-300">{t("options.rarityEffects")}</span>
              <p className="mb-3 text-xs text-gray-400">{t("options.rarityEffectsDescription")}</p>
              {/*
                割り当て対象はビルトイン4レアリティのみ。カスタムレアリティは
                従来どおり演出なし（旧実装ではエフェクトは legendary 限定だったため非退行）。
                必要なら fx= を手書きすればカスタムレアリティにも指定は可能
                （overlay 側の parse は任意のレアリティ名を受理する）。ただし "," や ":" を
                区切り文字として使うため、レアリティ名にこれらの文字を含む場合は
                encodeURIComponent でエンコードしてから埋め込む必要がある。
              */}
              <div className="space-y-2">
                {RARITIES.map((rarity) => (
                  <div key={rarity.value} className="flex items-center gap-3">
                    <span
                      className={`inline-flex w-24 shrink-0 items-center justify-center rounded-full px-2 py-1 text-xs font-medium text-white ${rarity.color}`}
                    >
                      {tRarity(rarity.value)}
                    </span>
                    <select
                      aria-label={t("options.rarityEffectLabel", { rarity: tRarity(rarity.value) })}
                      value={options.rarityEffects[rarity.value as BuiltinRarity]}
                      onChange={(e) => handleRarityEffectChange(rarity.value as BuiltinRarity, e.target.value)}
                      className="flex-1 rounded-lg border border-gray-600 bg-gray-700 px-3 py-2 text-sm text-white focus:border-purple-500 focus:outline-none"
                    >
                      {OVERLAY_EFFECT_STYLES.map((style) => (
                        <option key={style} value={style}>
                          {t(`options.effectStyles.${style}`)}
                        </option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* smallMode option */}
          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={options.smallMode}
              onChange={() => toggleOption("smallMode")}
              className="h-4 w-4 rounded border-gray-600 bg-gray-700 text-purple-600 focus:ring-purple-500"
            />
            <div>
              <span className="text-white">{t("options.smallMode")}</span>
              <p className="text-xs text-gray-400">{t("options.smallModeDescription")}</p>
            </div>
          </label>

          {/* displayDuration option - カードの表示時間設定 */}
          {/* Card display duration setting with slider */}
          <div className="pt-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-white">{t("options.displayDuration")}</span>
              <span className="text-sm text-purple-400 font-medium">{options.displayDuration}{t("options.seconds")}</span>
            </div>
            <input
              type="range"
              min="2"
              max="15"
              step="1"
              value={options.displayDuration}
              onChange={(e) => setOptions(prev => ({ ...prev, displayDuration: Number(e.target.value) }))}
              className="w-full h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-purple-600"
            />
            <div className="flex justify-between text-xs text-gray-500 mt-1">
              <span>2{t("options.seconds")}</span>
              <span>15{t("options.seconds")}</span>
            </div>
            <p className="text-xs text-gray-400 mt-1">{t("options.displayDurationDescription")}</p>
          </div>
        </div>

        {/* 縦長画像の付帯情報設定セクション（autoPortraitが有効な場合のみ表示） */}
        {/* Portrait image info section (only shown when autoPortrait is enabled) */}
        {options.autoPortrait && (
          <div className="mt-6 pt-4 border-t border-gray-600">
            <h4 className="mb-3 text-sm font-medium text-gray-300">
              {t("options.portraitInfoSection")}
            </h4>
            <div className="space-y-3 pl-2">
              {/* portraitShowUsername option */}
              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={options.portraitShowUsername}
                  onChange={() => toggleOption("portraitShowUsername")}
                  className="h-4 w-4 rounded border-gray-600 bg-gray-700 text-purple-600 focus:ring-purple-500"
                />
                <div>
                  <span className="text-white text-sm">{t("options.portraitShowUsername")}</span>
                  <p className="text-xs text-gray-400">{t("options.portraitShowUsernameDescription")}</p>
                </div>
              </label>

              {/* portraitShowName option */}
              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={options.portraitShowName}
                  onChange={() => toggleOption("portraitShowName")}
                  className="h-4 w-4 rounded border-gray-600 bg-gray-700 text-purple-600 focus:ring-purple-500"
                />
                <div>
                  <span className="text-white text-sm">{t("options.portraitShowName")}</span>
                  <p className="text-xs text-gray-400">{t("options.portraitShowNameDescription")}</p>
                </div>
              </label>

              {/* portraitShowRarity option */}
              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={options.portraitShowRarity}
                  onChange={() => toggleOption("portraitShowRarity")}
                  className="h-4 w-4 rounded border-gray-600 bg-gray-700 text-purple-600 focus:ring-purple-500"
                />
                <div>
                  <span className="text-white text-sm">{t("options.portraitShowRarity")}</span>
                  <p className="text-xs text-gray-400">{t("options.portraitShowRarityDescription")}</p>
                </div>
              </label>

              {/* portraitShowDescription option */}
              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={options.portraitShowDescription}
                  onChange={() => toggleOption("portraitShowDescription")}
                  className="h-4 w-4 rounded border-gray-600 bg-gray-700 text-purple-600 focus:ring-purple-500"
                />
                <div>
                  <span className="text-white text-sm">{t("options.portraitShowDescription")}</span>
                  <p className="text-xs text-gray-400">{t("options.portraitShowDescriptionDescription")}</p>
                </div>
              </label>
            </div>
          </div>
        )}
          </>
        )}
      </div>
      )}
    </div>
  );

  // コレクションページURLセクション（OBSブラウザソースとは別欄）
  // Collection page URL section (separate from OBS browser source)
  const collectionUrlSection = (
    <div className="rounded-xl bg-gray-800 p-6 h-full">
      <h2 className="mb-4 text-xl font-semibold text-white">
        {t("collectionUrl")}
      </h2>
      <p className="mb-4 text-sm text-gray-400">
        {t("collectionUrlDescription")}
      </p>
      <div className="flex gap-2">
        <input
          type="text"
          readOnly
          value={collectionUrl}
          className="flex-1 rounded-lg bg-gray-700 px-4 py-2 text-gray-200"
        />
        <CopyButton text={collectionUrl} />
      </div>
    </div>
  );

  // プレビューセクションのコンテンツ
  // Preview section content
  const previewSection = showPreview && (
    <div className="rounded-xl bg-gray-800 p-6">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 mb-4">
        <h3 className="text-xl font-semibold text-white">{t("preview")}</h3>

        {/* カード選択とアクションボタン */}
        {/* Card selection and action buttons */}
        <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3">
          {/* カード選択セレクトボックス（カードが登録されている場合のみ表示） */}
          {/* Card selector dropdown (only shown when cards are registered) */}
          {activeCards.length > 0 && (
            <select
              value={selectedCardId}
              onChange={(e) => setSelectedCardId(e.target.value)}
              className="rounded-lg bg-gray-700 px-3 py-2 text-sm text-white border border-gray-600 focus:border-purple-500 focus:outline-none min-w-[200px]"
            >
              <option value="random">ランダム</option>
              {activeCards.map((card) => (
                <option key={card.id} value={card.id}>
                  {card.name} ({card.rarity})
                </option>
              ))}
            </select>
          )}

          {/* プレビューデモボタン（プレビュー枠内のみ表示） */}
          {/* Preview demo button (shows only in preview area) */}
          <button
            onClick={triggerDemo}
            className="rounded-lg bg-purple-600 px-4 py-2 text-sm text-white hover:bg-purple-700 transition-colors whitespace-nowrap"
          >
            {t("previewDemo")}
          </button>

          {/* OBSデモボタン（Supabase RealtimeでOBSにも送信） */}
          {/* OBS demo button (broadcasts via Supabase Realtime to OBS) */}
          <button
            onClick={triggerObsDemo}
            disabled={isObsDemoExecuting}
            className={`rounded-lg px-4 py-2 text-sm text-white transition-colors whitespace-nowrap ${
              isObsDemoExecuting
                ? "bg-gray-600 cursor-not-allowed"
                : "bg-blue-600 hover:bg-blue-700"
            }`}
          >
            {isObsDemoExecuting ? "..." : t("obsDemo")}
          </button>

          {/* ヘルプアイコン（デモの違いを説明するモーダルを表示） */}
          {/* Help icon button (shows modal explaining demo differences) */}
          <button
            onClick={() => setShowDemoHelp(true)}
            className="w-6 h-6 rounded-full bg-gray-600 text-xs text-gray-300 hover:bg-gray-500 hover:text-white transition-colors flex items-center justify-center"
            title={t("demoHelpTitle")}
          >
            <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-8-3a1 1 0 00-.867.5 1 1 0 11-1.731-1A3 3 0 0113 8a3.001 3.001 0 01-2 2.83V11a1 1 0 11-2 0v-1a1 1 0 011-1 1 1 0 100-2zm0 8a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd" />
            </svg>
          </button>

          {/* 実際に引くボタン（Vercelプレビュー環境でのみ表示） */}
          {/* Real gacha button (only shown in Vercel preview environment) */}
          {isPreviewEnvironment && (
            <button
              onClick={triggerRealGacha}
              disabled={isExecuting}
              className={`rounded-lg px-4 py-2 text-sm text-white transition-colors whitespace-nowrap ${
                isExecuting
                  ? "bg-gray-600 cursor-not-allowed"
                  : "bg-green-600 hover:bg-green-700"
              }`}
            >
              {isExecuting ? "実行中..." : "実際に引く"}
            </button>
          )}
        </div>
      </div>
      <div className="rounded-lg overflow-hidden bg-gray-900 border border-gray-700">
        <iframe
          ref={iframeRef}
          src={overlayUrlWithParams}
          className="w-full h-[600px]"
          title="Overlay Preview"
        />
      </div>
      <p className="text-xs text-gray-500 mt-2">
        {t("demoNote")}
      </p>
      {/* プレビュー環境での説明文 */}
      {/* Explanation for preview environment */}
      {isPreviewEnvironment && activeCards.length > 0 && (
        <p className="text-xs text-gray-500 mt-1">
          ※「実際に引く」はプレビュー環境専用です。DBに記録され、履歴に残ります。
        </p>
      )}

      {/* デモヘルプモーダル */}
      {/* Demo help modal explaining the difference between preview and OBS demo */}
      {showDemoHelp && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-gray-800 rounded-xl p-6 max-w-md mx-4 shadow-xl">
            <h3 className="text-lg font-semibold text-white mb-4">
              {t("demoHelpTitle")}
            </h3>
            <div className="space-y-4">
              {/* プレビューDEMOの説明 */}
              <div>
                <h4 className="text-purple-400 font-medium mb-1">
                  {t("previewDemo")}
                </h4>
                <p className="text-sm text-gray-300">
                  {t("demoHelpContent.previewDemo")}
                </p>
              </div>
              {/* OBS DEMOの説明 */}
              <div>
                <h4 className="text-blue-400 font-medium mb-1">
                  {t("obsDemo")}
                </h4>
                <p className="text-sm text-gray-300">
                  {t("demoHelpContent.obsDemo")}
                </p>
              </div>
            </div>
            <button
              onClick={() => setShowDemoHelp(false)}
              className="mt-6 w-full rounded-lg bg-gray-700 px-4 py-2 text-sm text-white hover:bg-gray-600 transition-colors"
            >
              {t("close")}
            </button>
          </div>
        </div>
      )}
    </div>
  );

  // sideContent がある場合は横並びレイアウト、なければ縦並びレイアウト
  // Use side-by-side layout when sideContent is provided, otherwise stack vertically
  if (sideContent) {
    return (
      <div className="space-y-8">
        <div className="grid gap-8 lg:grid-cols-2">
          {urlSection}
          {sideContent}
        </div>
        {showCollectionUrl && collectionUrlSection}
        {previewSection}
      </div>
    );
  }

  return (
    <div className={showPreview || showCollectionUrl ? "space-y-8" : ""}>
      {urlSection}
      {showCollectionUrl && collectionUrlSection}
      {previewSection}
    </div>
  );
}
