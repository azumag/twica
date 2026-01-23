"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { useTranslations } from "next-intl";
import CopyButton from "@/components/CopyButton";

/**
 * Overlay preview options interface
 * オーバーレイプレビューのオプション設定インターフェース
 */
interface OverlayOptions {
  imageOnly: boolean;       // 画像のみ表示（カード枠なし）
  autoPortrait: boolean;    // 縦長画像を自動検出してオリジナル表示
  effects: boolean;         // レジェンダリーのキラキラエフェクト表示
  smallMode: boolean;       // 小さい画像用の縮小表示モード
}

interface OverlayPreviewProps {
  streamerId: string;
  baseUrl: string;
  showPreview?: boolean;  // プレビューセクションを表示するかどうか（デフォルト: true）
  sideContent?: React.ReactNode;  // URLセクションの横に表示するコンテンツ（横並びレイアウト用）
}

/**
 * Overlay Preview Component
 * オーバーレイ設定のプレビューコンポーネント
 * - OBSブラウザソースURLの表示（オプション変更で自動更新）
 * - URLパラメータオプションの設定
 * - iframeでのプレビュー表示
 * - DEMOボタンで配信者のカードを表示
 */
export default function OverlayPreview({ streamerId, baseUrl, showPreview = true, sideContent }: OverlayPreviewProps) {
  const t = useTranslations("overlaySettings");
  const tDashboard = useTranslations("dashboard");

  // オーバーレイオプションの状態管理
  // autoPortraitとsmallModeはデフォルトでtrue（より良い表示体験のため）
  const [options, setOptions] = useState<OverlayOptions>({
    imageOnly: false,
    autoPortrait: true,  // デフォルトでポートレイト画像を自動検出
    effects: true,
    smallMode: true,     // デフォルトで小さい画像モードを有効化
  });

  // URL更新メッセージの表示状態
  const [showUrlUpdated, setShowUrlUpdated] = useState(false);
  // 初回レンダリングフラグ（初回は更新メッセージを表示しない）
  const isFirstRender = useRef(true);

  // iframeの参照（DEMOボタン用）
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // 現在のオプションからURLパラメータを生成（ユーザー向けURL用）
  // Generate URL parameters from current options (for user-facing URL)
  // autoPortrait, smallMode, effectsはデフォルトでtrue（falseの場合のみURLパラメータで明示）
  const buildUrlParams = useCallback(() => {
    const params = new URLSearchParams();
    if (options.imageOnly) params.set("imageOnly", "true");
    if (!options.autoPortrait) params.set("autoPortrait", "false");  // デフォルトtrue、falseの場合のみ出力
    if (!options.effects) params.set("effects", "false");             // デフォルトtrue、falseの場合のみ出力
    if (!options.smallMode) params.set("smallMode", "false");        // デフォルトtrue、falseの場合のみ出力
    return params.toString();
  }, [options]);

  // プレビュー用のURLパラメータを生成（hideDemoを含む）
  // Generate URL parameters for preview iframe (includes hideDemo)
  // autoPortrait, smallMode, effectsはデフォルトでtrue（falseの場合のみURLパラメータで明示）
  const buildPreviewUrlParams = useCallback(() => {
    const params = new URLSearchParams();
    if (options.imageOnly) params.set("imageOnly", "true");
    if (!options.autoPortrait) params.set("autoPortrait", "false");  // デフォルトtrue、falseの場合のみ出力
    if (!options.effects) params.set("effects", "false");             // デフォルトtrue、falseの場合のみ出力
    if (!options.smallMode) params.set("smallMode", "false");        // デフォルトtrue、falseの場合のみ出力
    params.set("hideDemo", "true"); // プレビューではDEMOボタンを非表示
    return params.toString();
  }, [options]);

  // オーバーレイURLを生成
  const overlayUrl = `${baseUrl}/overlay/${streamerId}`;
  // ユーザー向けURL（コピー用）- hideDemoは含まない
  const userParams = buildUrlParams();
  const overlayUrlWithParams = userParams ? `${overlayUrl}?${userParams}` : overlayUrl;
  // プレビュー用URL - hideDemoを含む
  const previewParams = buildPreviewUrlParams();
  const previewUrl = `${overlayUrl}?${previewParams}`;

  // オプション変更時にURL更新メッセージを表示
  // 初回レンダリング時は表示しない
  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    // メッセージを表示
    setShowUrlUpdated(true);
    // 3秒後に非表示
    const timer = setTimeout(() => {
      setShowUrlUpdated(false);
    }, 3000);
    return () => clearTimeout(timer);
  }, [options]);

  // DEMOを実行（iframe内のオーバーレイにメッセージを送信）
  // Trigger demo in iframe by refreshing with demo param
  const triggerDemo = useCallback(() => {
    if (iframeRef.current) {
      // iframeをリロードしてdemoパラメータ付きで再読み込み
      // プレビュー用パラメータを使用（hideDemoを含む）
      iframeRef.current.src = `${overlayUrl}?${previewParams}&demo=true`;
    }
  }, [overlayUrl, previewParams]);

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
      </div>
    </div>
  );

  // プレビューセクションのコンテンツ
  // Preview section content
  const previewSection = showPreview && (
    <div className="rounded-xl bg-gray-800 p-6">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-xl font-semibold text-white">{t("preview")}</h3>
        <button
          onClick={triggerDemo}
          className="rounded-lg bg-purple-600 px-4 py-2 text-sm text-white hover:bg-purple-700 transition-colors"
        >
          {t("runDemo")}
        </button>
      </div>
      <div className="rounded-lg overflow-hidden bg-gray-900 border border-gray-700">
        <iframe
          ref={iframeRef}
          src={previewUrl}
          className="w-full h-[600px]"
          title="Overlay Preview"
        />
      </div>
      <p className="text-xs text-gray-500 mt-2">
        {t("demoNote")}
      </p>
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
