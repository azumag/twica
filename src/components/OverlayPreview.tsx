"use client";

import { useState, useRef, useCallback } from "react";
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
}

/**
 * Overlay Preview Component
 * オーバーレイ設定のプレビューコンポーネント
 * - URLパラメータオプションの設定
 * - iframeでのプレビュー表示
 * - DEMOボタンで配信者のカードを表示
 */
export default function OverlayPreview({ streamerId, baseUrl }: OverlayPreviewProps) {
  const t = useTranslations("overlaySettings");

  // オーバーレイオプションの状態管理
  const [options, setOptions] = useState<OverlayOptions>({
    imageOnly: false,
    autoPortrait: false,
    effects: true,
    smallMode: false,
  });

  // iframeの参照（DEMOボタン用）
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // 現在のオプションからURLパラメータを生成（ユーザー向けURL用）
  // Generate URL parameters from current options (for user-facing URL)
  const buildUrlParams = useCallback(() => {
    const params = new URLSearchParams();
    if (options.imageOnly) params.set("imageOnly", "true");
    if (options.autoPortrait) params.set("autoPortrait", "true");
    if (!options.effects) params.set("effects", "false");
    if (options.smallMode) params.set("smallMode", "true");
    return params.toString();
  }, [options]);

  // プレビュー用のURLパラメータを生成（hideDemoを含む）
  // Generate URL parameters for preview iframe (includes hideDemo)
  const buildPreviewUrlParams = useCallback(() => {
    const params = new URLSearchParams();
    if (options.imageOnly) params.set("imageOnly", "true");
    if (options.autoPortrait) params.set("autoPortrait", "true");
    if (!options.effects) params.set("effects", "false");
    if (options.smallMode) params.set("smallMode", "true");
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

  return (
    <div className="rounded-xl bg-gray-800 p-6">
      <h3 className="mb-4 text-xl font-semibold text-white">
        {t("title")}
      </h3>

      {/* オプション設定 */}
      <div className="mb-4 space-y-3">
        <p className="text-sm text-gray-400 mb-3">
          {t("description")}
        </p>

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

      {/* 生成されたURL */}
      <div className="mb-4">
        <label className="text-sm text-gray-400 block mb-2">{t("generatedUrl")}</label>
        <div className="flex gap-2">
          <input
            type="text"
            readOnly
            value={overlayUrlWithParams}
            className="flex-1 rounded-lg bg-gray-700 px-4 py-2 text-gray-200 text-sm"
          />
          <CopyButton text={overlayUrlWithParams} />
        </div>
      </div>

      {/* プレビューエリア */}
      <div className="mb-4">
        <div className="flex items-center justify-between mb-2">
          <label className="text-sm text-gray-400">{t("preview")}</label>
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
            className="w-full h-[400px]"
            title="Overlay Preview"
          />
        </div>
        <p className="text-xs text-gray-500 mt-2">
          {t("demoNote")}
        </p>
      </div>
    </div>
  );
}
