"use client";

import { useCallback, useState } from "react";
import { useTranslations } from "next-intl";
import { logger } from "@/lib/logger";
import { parseMaintenanceError } from "@/lib/maintenance/client";
import { useMaintenanceStatus } from "./MaintenanceStatusProvider";
import { DEFAULT_PACK_SENTINEL } from "@/lib/validation/collection-name";
import {
  ALBUM_ALL_PACKS_KEY,
  ALBUM_GRID_SIZES,
  normalizeAlbumGridSize,
  sanitizeAlbumGridSizeMap,
  type AlbumDefaultView,
  type AlbumGridSizeMap,
} from "@/lib/collection-album";

interface AlbumDisplaySettingsProps {
  streamerId: string;
  // 配信者のパックカタログ（card_pack_names）。各行に1スコープを出す。
  packNames: string[];
  // 「デフォルト」(未分類) パックの表示名オーバーライド（null = 汎用ラベル）
  defaultPackName: string | null;
  // 保存済みの並び既定（スコープキー → N）と初期表示モード
  currentAlbumGridSizes: AlbumGridSizeMap;
  currentAlbumDefaultView: AlbumDefaultView;
}

// 「既定に従う」= そのキーのエントリを削除する（__all__ の値、無ければ 3×3）。
const INHERIT_VALUE = "";

/**
 * アルバム表示設定 (#1765 フォローアップ)
 *
 * コレクションページのアルバム表示について、配信者がコレクション(カードパック)
 * ごとの既定の並び (N×N) と、ページの初期表示モードを指定する。
 *
 * 保存は既存の POST /api/streamer/settings（CSRF・maintenance・デプロイ窓の
 * フォールバックを共通で持つ唯一の配信者設定経路）へ、変更のたびにマップ全体を
 * 送る。カード公開設定と同じく、保存できなかった場合は画面上の値を元へ戻し、
 * 「保存したつもり」を作らない。
 *
 * Settings for the album view: per-collection (pack) default grid size and the
 * collection page's initial view mode. Persisted through the shared streamer
 * settings route so CSRF / maintenance / deploy-window behavior stays single.
 */
export default function AlbumDisplaySettings({
  streamerId,
  packNames,
  defaultPackName,
  currentAlbumGridSizes,
  currentAlbumDefaultView,
}: AlbumDisplaySettingsProps) {
  const t = useTranslations("albumDisplaySettings");
  const tMaintenance = useTranslations("maintenance");
  // #694 Stage 6b: ダッシュボード共有Context経由のmaintenance状態。
  const { mode: maintenanceMode } = useMaintenanceStatus();
  const isMaintenanceBlocked = maintenanceMode !== "off";

  const [gridSizes, setGridSizes] = useState<AlbumGridSizeMap>(currentAlbumGridSizes);
  const [defaultView, setDefaultView] = useState<AlbumDefaultView>(currentAlbumDefaultView);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [isError, setIsError] = useState(false);

  const saveSettings = useCallback(
    async (payload: {
      packAlbumGridSizes?: AlbumGridSizeMap;
      collectionDefaultView?: AlbumDefaultView;
    }): Promise<boolean> => {
      setSaving(true);
      try {
        const response = await fetch("/api/streamer/settings", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ streamerId, ...payload }),
        });
        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          const maintenanceError = parseMaintenanceError(response, errorData);
          setMessage(maintenanceError?.message || errorData.error || t("errors.saveFailed"));
          setIsError(true);
          return false;
        }
        // サーバ側で prune（カタログから消えたパックの既定を除去）された確定値を
        // 取り込み、表示と DB を一致させる。応答に含まれない場合は送信値を保持する。
        const data: unknown = await response.json().catch(() => null);
        if (data && typeof data === "object") {
          const echoed = (data as {
            packAlbumGridSizes?: unknown;
            collectionDefaultView?: unknown;
          });
          if (payload.packAlbumGridSizes !== undefined && "packAlbumGridSizes" in echoed) {
            setGridSizes(sanitizeAlbumGridSizeMap(echoed.packAlbumGridSizes));
          }
          if (echoed.collectionDefaultView === "grid" || echoed.collectionDefaultView === "album") {
            setDefaultView(echoed.collectionDefaultView);
          }
        }
        setIsError(false);
        setMessage(t("messages.saved"));
        return true;
      } catch (error) {
        logger.error("AlbumDisplaySettings save failed:", error);
        setMessage(t("errors.saveFailed"));
        setIsError(true);
        return false;
      } finally {
        setSaving(false);
      }
    },
    [streamerId, t]
  );

  const handleGridSizeChange = useCallback(
    async (scopeKey: string, rawValue: string) => {
      // disabled 中（maintenance / 保存中）は、DOM 側で change が発火しても
      // 書き込みを送らない。UI の disabled だけに依存しない。
      if (isMaintenanceBlocked || saving) return;
      const previous = gridSizes;
      const next: AlbumGridSizeMap = { ...gridSizes };
      if (rawValue === INHERIT_VALUE) {
        delete next[scopeKey];
      } else {
        const size = normalizeAlbumGridSize(Number(rawValue));
        if (size === null) return;
        next[scopeKey] = size;
      }
      setGridSizes(next);
      const ok = await saveSettings({ packAlbumGridSizes: next });
      if (!ok) setGridSizes(previous);
    },
    [gridSizes, saveSettings, isMaintenanceBlocked, saving]
  );

  const handleDefaultViewChange = useCallback(
    async (next: AlbumDefaultView) => {
      if (isMaintenanceBlocked || saving) return;
      if (next === defaultView) return;
      const previous = defaultView;
      setDefaultView(next);
      const ok = await saveSettings({ collectionDefaultView: next });
      if (!ok) setDefaultView(previous);
    },
    [defaultView, saveSettings, isMaintenanceBlocked, saving]
  );

  // 表示順は すべて → デフォルト → カタログ順。重複名は1行に畳む。
  const scopes: { key: string; label: string }[] = [
    { key: ALBUM_ALL_PACKS_KEY, label: t("allPacks") },
    {
      key: DEFAULT_PACK_SENTINEL,
      label: defaultPackName ?? t("defaultPackFallback"),
    },
    ...[...new Set(packNames)].map((name) => ({ key: name, label: name })),
  ];

  const disabled = saving || isMaintenanceBlocked;
  const optionLabel = (size: number) =>
    t("gridSizeOption", { size: String(size) });

  return (
    <div className="rounded-xl bg-gray-800 p-6">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-xl font-semibold text-white">{t("title")}</h2>
      </div>

      <p className="mb-4 text-sm text-gray-400">{t("description")}</p>

      {isMaintenanceBlocked && (
        <p className="mb-4 text-sm text-yellow-400">{tMaintenance("writeDisabled")}</p>
      )}

      <div className="space-y-4">
        {/* 初期表示モード（ページを開いたときのカード / アルバム） */}
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm text-gray-300">{t("viewLabel")}</span>
          {(
            [
              ["grid", t("viewGrid")],
              ["album", t("viewAlbum")],
            ] as const
          ).map(([mode, label]) => (
            <button
              key={mode}
              type="button"
              onClick={() => void handleDefaultViewChange(mode)}
              disabled={disabled}
              aria-pressed={defaultView === mode}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-50 ${
                defaultView === mode
                  ? "bg-purple-600 text-white"
                  : "border border-gray-600 text-gray-300 hover:bg-gray-700"
              }`}
            >
              {label}
            </button>
          ))}
          <span className="text-xs text-gray-500">{t("viewHelp")}</span>
        </div>

        {/* コレクション(パック)ごとの並び N×N */}
        <div>
          <p className="text-sm text-gray-300">{t("gridSizeTitle")}</p>
          <p className="mt-1 text-xs text-gray-500">{t("gridSizeHelp")}</p>
          <div className="mt-3 space-y-3">
            {scopes.map((scope) => {
              const current = gridSizes[scope.key];
              return (
                <div key={scope.key} className="flex flex-wrap items-center gap-3">
                  <span className="min-w-0 break-words text-sm text-gray-200">
                    {scope.label}
                  </span>
                  <label className="ml-auto flex items-center gap-2 text-xs text-gray-400">
                    <span>{t("gridSizeLabel")}</span>
                    <select
                      aria-label={`${scope.label} ${t("gridSizeLabel")}`}
                      value={
                        normalizeAlbumGridSize(current) === null
                          ? INHERIT_VALUE
                          : String(current)
                      }
                      onChange={(event) =>
                        void handleGridSizeChange(scope.key, event.target.value)
                      }
                      disabled={disabled}
                      className="rounded-lg border border-gray-600 bg-gray-800 px-2 py-1 text-sm text-gray-200 disabled:opacity-50"
                    >
                      <option value={INHERIT_VALUE}>{t("gridSizeInherit")}</option>
                      {ALBUM_GRID_SIZES.map((size) => (
                        <option key={size} value={String(size)}>
                          {optionLabel(size)}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              );
            })}
          </div>
        </div>

        {message && (
          <p className={`text-sm ${isError ? "text-red-400" : "text-green-400"}`}>
            {message}
          </p>
        )}
        {saving && <p className="text-sm text-gray-400">{t("messages.saving")}</p>}
      </div>
    </div>
  );
}
