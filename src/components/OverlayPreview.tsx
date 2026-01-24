"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { useTranslations } from "next-intl";
import CopyButton from "@/components/CopyButton";
import type { Card } from "@/types/database";

/**
 * Overlay preview options interface
 * オーバーレイプレビューのオプション設定インターフェース
 */
interface OverlayOptions {
  imageOnly: boolean;       // 画像のみ表示（カード枠なし）
  autoPortrait: boolean;    // 縦長画像を自動検出してオリジナル表示
  effects: boolean;         // レジェンダリーのキラキラエフェクト表示
  smallMode: boolean;       // 小さい画像用の縮小表示モード
  // 縦長画像の付帯情報表示オプション（画像に被らず下に表示）
  // Portrait image info options (displayed below image, not overlapping)
  portraitShowName: boolean;        // 縦長画像でカード名を表示
  portraitShowRarity: boolean;      // 縦長画像でレアリティを表示
  portraitShowDescription: boolean; // 縦長画像で説明を表示
  portraitShowUsername: boolean;    // 縦長画像でユーザー名を表示
}

interface OverlayPreviewProps {
  streamerId: string;
  baseUrl: string;
  showPreview?: boolean;  // プレビューセクションを表示するかどうか（デフォルト: true）
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
export default function OverlayPreview({ streamerId, baseUrl, showPreview = true, sideContent, cards = [] }: OverlayPreviewProps) {
  const t = useTranslations("overlaySettings");
  const tDashboard = useTranslations("dashboard");

  // オーバーレイオプションの状態管理
  // autoPortraitとsmallModeはデフォルトでtrue（より良い表示体験のため）
  const [options, setOptions] = useState<OverlayOptions>({
    imageOnly: false,
    autoPortrait: true,  // デフォルトでポートレイト画像を自動検出
    effects: true,
    smallMode: true,     // デフォルトで小さい画像モードを有効化
    // 縦長画像の付帯情報はデフォルトでレアリティのみ表示
    // Portrait info defaults to showing rarity only
    portraitShowName: false,
    portraitShowRarity: true,
    portraitShowDescription: false,
    portraitShowUsername: false,
  });

  // URL更新メッセージの表示状態
  const [showUrlUpdated, setShowUrlUpdated] = useState(false);
  // 初回レンダリングフラグ（初回は更新メッセージを表示しない）
  const isFirstRender = useRef(true);

  // iframeの参照（DEMOボタン用）
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // デバッグ用：選択されたカードID（"random"でランダム、カードIDで特定のカード）
  // Debug: selected card ID for demo/gacha ("random" for random selection, card ID for specific card)
  const [selectedCardId, setSelectedCardId] = useState<string>("random");

  // 実行中状態の管理（重複実行防止）
  const [isExecuting, setIsExecuting] = useState(false);

  // 現在のオプションからURLパラメータを生成（ユーザー向けURL用）
  // Generate URL parameters from current options (for user-facing URL)
  // autoPortrait, smallMode, effectsはデフォルトでtrue（falseの場合のみURLパラメータで明示）
  // portraitShowRarityはデフォルトでtrue、それ以外はfalse
  const buildUrlParams = useCallback(() => {
    const params = new URLSearchParams();
    if (options.imageOnly) params.set("imageOnly", "true");
    if (!options.autoPortrait) params.set("autoPortrait", "false");  // デフォルトtrue、falseの場合のみ出力
    if (!options.effects) params.set("effects", "false");             // デフォルトtrue、falseの場合のみ出力
    if (!options.smallMode) params.set("smallMode", "false");        // デフォルトtrue、falseの場合のみ出力
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
  }, [options]);

  // DEMOを実行（iframe内のオーバーレイにメッセージを送信）
  // 選択されたカードID（またはランダム）でデモを実行
  // Trigger demo in iframe by refreshing with demo param and optional cardId
  const triggerDemo = useCallback(() => {
    if (iframeRef.current) {
      // iframeをリロードしてdemoパラメータ付きで再読み込み
      // カードIDも指定（"random"の場合はランダム選択）
      let demoUrl = urlParams ? `${overlayUrl}?${urlParams}&demo=true` : `${overlayUrl}?demo=true`;
      if (selectedCardId && selectedCardId !== "random") {
        demoUrl += `&cardId=${selectedCardId}`;
      }
      iframeRef.current.src = demoUrl;
    }
  }, [overlayUrl, urlParams, selectedCardId]);

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

      {/* コレクションページURL */}
      {/* Collection page URL */}
      <div className="mt-4">
        <h3 className="mb-2 text-sm font-medium text-gray-300">
          {t("collectionUrl")}
        </h3>
        <p className="mb-2 text-xs text-gray-400">
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

      {/* URL更新メッセージ - 高さを常に確保してレイアウトシフトを防ぐ */}
      {/* Use fixed height and opacity transition to prevent layout shift */}
      <p
        className={`mt-2 h-5 text-sm text-green-400 transition-opacity duration-300 ${
          showUrlUpdated ? "opacity-100" : "opacity-0"
        }`}
      >
        {t("urlUpdated")}
      </p>

      {/* オーバーレイカスタマイズオプション */}
      <div className="mt-6 pt-6 border-t border-gray-700">
        <h3 className="mb-3 text-lg font-semibold text-white">
          {t("title")}
        </h3>
        <p className="text-sm text-gray-400 mb-4">
          {t("description")}
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
      </div>
    </div>
  );

  // アクティブなカードのみフィルタリング（デモ/ガチャで使用）
  // Filter only active cards for demo/gacha
  const activeCards = cards.filter(card => card.is_active);

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

          {/* デモボタン（全環境で表示） */}
          {/* Demo button (shown in all environments) */}
          <button
            onClick={triggerDemo}
            className="rounded-lg bg-purple-600 px-4 py-2 text-sm text-white hover:bg-purple-700 transition-colors whitespace-nowrap"
          >
            {t("runDemo")}
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
    </div>
  );

  // sideContent がある場合は横並びレイアウト、なければ縦並びレイアウト
  // Use side-by-side layout when sideContent is provided, otherwise stack vertically
  if (sideContent) {
    return (
      <div className="space-y-8">
        {/* URLセクションとsideContentを横並びに配置 */}
        {/* Place URL section and sideContent side by side */}
        <div className="grid gap-8 lg:grid-cols-2">
          {urlSection}
          {sideContent}
        </div>
        {/* プレビューは全幅で下に配置 */}
        {/* Preview section spans full width below */}
        {previewSection}
      </div>
    );
  }

  return (
    <div className={showPreview ? "space-y-8" : ""}>
      {urlSection}
      {previewSection}
    </div>
  );
}
