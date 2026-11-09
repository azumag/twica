"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import {
  RARITIES,
  MAX_RARITY_KEY_LENGTH,
  MAX_CUSTOM_RARITIES,
  RARITY_CONTROL_CHAR_REGEX as CONTROL_CHAR_REGEX,
  RARITY_BIDI_OVERRIDE_REGEX as BIDI_OVERRIDE_REGEX,
} from "@/lib/constants";
import { logger } from "@/lib/logger";
import { isEnterKeySubmit } from "@/lib/keyboard-utils";
import { getRarityStylePresentation } from "@/lib/rarity";
import {
  normalizeColorValue,
  normalizeGlowValue,
  normalizeGradientValue,
  type RarityStyle,
} from "@/lib/rarity-styles";
import { parseMaintenanceError } from "@/lib/maintenance/client";
import { useMaintenanceStatus } from "./MaintenanceStatusProvider";

// ここでの事前検証は UX 向上のためで、最終的な検証はサーバーが行う
// (POST /api/streamer/settings)。検証規則は constants の共通定数を共有する。

const DEFAULT_RARITY_VALUES = new Set<string>(RARITIES.map((r) => r.value));

/**
 * Issue #1783: スタイルマップをキー順に依存せず比較するための署名。
 * 指定キーのうち実体のあるスタイルだけを、キー名とプロパティ名で整列して直列化する。
 */
function styleSignature(styles: Record<string, RarityStyle>, keys: string[]): string {
  return JSON.stringify(
    keys
      .filter((key) => styles[key] && Object.keys(styles[key]).length > 0)
      .slice()
      .sort()
      .map((key) => [
        key,
        Object.entries(styles[key]).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      ])
  );
}

/**
 * Issue #2029: `<input type="color">` は #RRGGBB しか扱えないため、保存値を
 * ピッカー用の6桁HEXへ揃える。#RGB は各桁を複写し、それ以外の不正値・未設定は
 * グレーへ倒す（ピッカーが黒に化けて「設定済みに見える」事故を防ぐ）。
 */
function toColorInputValue(hex: string | undefined): string {
  if (!hex) return "#808080";
  // DB にはフェーズ1の Tailwind クラス形式（"bg-red-500" 等）が残り得るため、
  // 保存時と同じ正規化を先に通してからピッカーへ渡す（#2029）。
  const value = normalizeColorValue(hex.trim()) ?? hex.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(value)) return value;
  if (/^#[0-9a-fA-F]{3}$/.test(value)) {
    return `#${value
      .slice(1)
      .split("")
      .map((c) => c + c)
      .join("")}`;
  }
  return "#808080";
}

/**
 * Issue #2029: グローの保存値（#RRGGBB または #RRGGBBAA）を、色ピッカー用の
 * RGB 部と不透明度スライダー用の 0-100% に分解する。#RGB / #RGBA 等の短縮形は
 * アルファを持たない色として扱う（検証側も 8 桁以外のアルファを許可しない）。
 */
function parseGlowValue(glow: string | undefined): { color: string; opacity: number } {
  // legacy の "shadow-purple-500/50" 形式も HEX8 へ正規化してから分解する。
  const normalized = glow ? normalizeGlowValue(glow) : undefined;
  if (normalized && /^#[0-9a-fA-F]{8}$/.test(normalized)) {
    return {
      color: normalized.slice(0, 7),
      opacity: Math.round((parseInt(normalized.slice(7), 16) / 255) * 100),
    };
  }
  return { color: toColorInputValue(normalized ?? glow), opacity: 100 };
}

/**
 * Issue #2029: グローの色と不透明度から保存値を組み立てる。不透明度100%は
 * アルファを付けず #RRGGBB のまま保存する（値を最小限に保ち、従来の
 * `<input type="color">` だけで編集できる値と同じ形式に揃える）。
 */
function composeGlowValue(color: string, opacity: number): string {
  if (opacity >= 100) return color;
  const alpha = Math.round((opacity / 100) * 255)
    .toString(16)
    .padStart(2, "0");
  return `${color}${alpha}`;
}

/**
 * Issue #2029: 保存済みグラデーション（"#rrggbb,#rrggbb"）を from/to に分解する。
 * 未設定・片方だけ・不正値の側は #808080 に倒し、ピッカーが常に有効な値を持つ
 * ようにする（実際の描画でグレーになる既定値と同じ色）。
 */
function parseGradientValue(gradient: string | undefined): [string, string] {
  // legacy の "from-red-500 to-blue-600" 形式も HEX ペアへ正規化してから分解する。
  const normalized = gradient ? normalizeGradientValue(gradient) : undefined;
  const parts = normalized?.split(",").map((part) => part.trim()) ?? [];
  return [toColorInputValue(parts[0]), toColorInputValue(parts[1])];
}

interface CustomRarityModalProps {
  isOpen: boolean;
  onClose: () => void;
  streamerId: string;
  customRarities: string[];
  rarityStyles?: Record<string, RarityStyle>;
  onSaved: (next: string[]) => void;
  onSavedStyles?: (next: Record<string, RarityStyle>) => void;
}

/**
 * CustomRarityModal - カスタムレアリティ名の管理モーダル
 *
 * デフォルトレアリティ (RARITIES) は常に選択可能なため読み取り専用で表示し、
 * 削除できない。カスタムレアリティ名のみ追加/削除でき、保存すると
 * streamers.custom_rarities に永続化される。
 *
 * このモーダルはレアリティ「名」のみを扱い、ドロップ率設定 (rarity_weights)
 * とは完全に独立している。そのため保存してもカードの排出確率は再計算されない。
 */
export default function CustomRarityModal({
  isOpen,
  onClose,
  streamerId,
  customRarities,
  rarityStyles,
  onSaved,
  onSavedStyles,
}: CustomRarityModalProps) {
  const t = useTranslations("cardManager");
  const tRarity = useTranslations("rarity");
  const tMaintenance = useTranslations("maintenance");
  // #694 Stage 6c: ダッシュボード共有Context経由のmaintenance状態。
  // 保存のたびに個別fetchしない設計（MaintenanceStatusProvider参照）。
  const { mode: maintenanceMode } = useMaintenanceStatus();
  const isMaintenanceBlocked = maintenanceMode !== "off";

  const [list, setList] = useState<string[]>(customRarities);
  const [styles, setStyles] = useState<Record<string, RarityStyle>>(rarityStyles ?? {});
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Issue #1783: デプロイ窓の部分保存（名前だけ保存されスタイルは未保存）で親へ通知した
  // payload。親がその値を採用した1回だけ、未保存の色の下書きを維持するために使う
  // （#1822 の同名実装と同じ扱い。重複実装を増やさないため挙動を合わせている）。
  const partialSaveSync = useRef<{
    customRarities: string[];
    rarityStyles: Record<string, RarityStyle>;
  } | null>(null);
  const previousIsOpen = useRef(false);

  // モーダルを開くたびに、保存済みの最新値から編集を開始する。
  // 閉じている間に親の customRarities が変わってもズレないようにする。
  useEffect(() => {
    const wasOpen = previousIsOpen.current;
    previousIsOpen.current = isOpen;
    if (!isOpen) {
      partialSaveSync.current = null;
      return;
    }
    // 部分保存で通知した payload を親が採用する1回だけ、未保存の色を維持する。
    // 閉じた後に応答が来ても、次回 open は必ず保存済みの値から初期化する。
    const partialSave = partialSaveSync.current;
    partialSaveSync.current = null;
    if (
      wasOpen &&
      partialSave &&
      partialSave.customRarities === customRarities &&
      partialSave.rarityStyles === rarityStyles
    ) {
      return;
    }
    setList(customRarities);
    setStyles(rarityStyles ?? {});
    setInput("");
    setError(null);
  }, [isOpen, customRarities, rarityStyles]);

  // Issue #1783: スタイルは「リストに残っているレアリティ」の分だけを保存対象にする。
  // レアリティを削除したときにスタイルが残ると、サーバー側の allowedKeys 検証で
  // 400 になり保存できなくなるため、ここで落とす。
  const stylesForList = useMemo(() => {
    const next: Record<string, RarityStyle> = {};
    for (const key of list) {
      const style = styles[key];
      if (style && Object.keys(style).length > 0) next[key] = style;
    }
    return next;
  }, [list, styles]);

  const hasChanges = useMemo(() => {
    if (list.length !== customRarities.length) return true;
    if (list.some((v, i) => v !== customRarities[i])) return true;
    // Issue #1783: 色などのスタイルだけを変えた場合も保存対象にする
    // （名前が変わっていないと保存ボタンが押せない、という取りこぼしを防ぐ）。
    return styleSignature(stylesForList, list) !== styleSignature(rarityStyles ?? {}, list);
  }, [list, customRarities, stylesForList, rarityStyles]);

  if (!isOpen) return null;

  const handleClose = () => {
    if (hasChanges && !confirm(t("customRarity.confirmClose"))) return;
    // 次回開いたときに保存済みの値から再開できるよう破棄
    partialSaveSync.current = null;
    setList(customRarities);
    // Issue #1783: スタイルも保存済みの値へ戻す（未保存の色変更を持ち越さない）。
    setStyles(rarityStyles ?? {});
    setInput("");
    setError(null);
    onClose();
  };

  const handleAdd = () => {
    const key = input.trim().normalize("NFC");
    if (key.length < 1) {
      setError(t("customRarity.errorEmpty"));
      return;
    }
    if (key.length > MAX_RARITY_KEY_LENGTH) {
      setError(t("customRarity.errorTooLong"));
      return;
    }
    if (CONTROL_CHAR_REGEX.test(key) || BIDI_OVERRIDE_REGEX.test(key)) {
      setError(t("customRarity.errorInvalidChars"));
      return;
    }
    if (DEFAULT_RARITY_VALUES.has(key)) {
      setError(t("customRarity.errorDefault"));
      return;
    }
    if (list.includes(key)) {
      setError(t("customRarity.errorDuplicate"));
      return;
    }
    if (list.length >= MAX_CUSTOM_RARITIES) {
      setError(t("customRarity.errorMax", { max: MAX_CUSTOM_RARITIES }));
      return;
    }
    setList([...list, key]);
    setInput("");
    setError(null);
  };

  const handleRemove = (value: string) => {
    setList(list.filter((v) => v !== value));
    // Issue #1783: レアリティを外したらスタイルも一緒に落とす。残すとサーバー側の
    // allowedKeys 検証で 400 になり、他の編集ごと保存できなくなる。
    setStyles((prev) => {
      if (!(value in prev)) return prev;
      const next = { ...prev };
      delete next[value];
      return next;
    });
  };

  // Issue #2029: プロパティ単位の更新・既定戻しを共通化する。
  // 文字色と同じく「未設定のキーは送らない」ため、消したプロパティは delete し、
  // 全プロパティが空になったらそのレアリティのエントリごと落とす。
  const updateRarityStyle = (key: string, patch: Partial<RarityStyle>) =>
    setStyles((prev) => ({ ...prev, [key]: { ...(prev[key] ?? {}), ...patch } }));

  const clearRarityStyleProp = (key: string, prop: keyof RarityStyle) =>
    setStyles((prev) => {
      const next = { ...prev };
      const current = { ...(next[key] ?? {}) };
      delete current[prop];
      if (Object.keys(current).length === 0) {
        delete next[key];
      } else {
        next[key] = current;
      }
      return next;
    });

  const handleSave = async () => {
    // #694 Stage 6c: フッターのSaveボタン自体はdisableしているが、
    // CardManager.handleSubmitと同じ方針で送信経路の先頭でも二重にガードする。
    if (isMaintenanceBlocked) {
      setError(tMaintenance("writeDisabled"));
      return;
    }
    setSaving(true);
    setError(null);
    partialSaveSync.current = null;
    try {
      const response = await fetch("/api/streamer/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ streamerId, customRarities: list, rarityStyles: stylesForList }),
      });
      const data = await response.json();
      if (!response.ok) {
        // maintenance mode による503拒否ならサーバーの案内文言を優先する。
        const maintenanceError = parseMaintenanceError(response, data);
        throw new Error(maintenanceError?.message || data.error || t("customRarity.saveFailed"));
      }
      // Issue #1783: デプロイ窓で rarity_styles 列がまだ無い環境では、サーバーは他の設定
      // だけを保存して 200 + rarityStylesSkippedDeployWindow を返す。ここで成功扱いにして
      // 閉じると「保存できたように見えて色が失われる」ため、名前の保存だけを反映し、
      // スタイルは保存済みの値を維持して、未保存の下書きと警告を残す（#1822 と同じ扱い）。
      if (data.rarityStylesSkippedDeployWindow === true) {
        const persisted = { customRarities: list, rarityStyles: rarityStyles ?? {} };
        partialSaveSync.current = persisted;
        onSaved(persisted.customRarities);
        onSavedStyles?.(persisted.rarityStyles);
        setError(t("customRarity.stylesNotSaved"));
        return;
      }
      onSaved(list);
      onSavedStyles?.(stylesForList);
      onClose();
    } catch (err) {
      logger.error("Failed to save custom rarities:", err);
      setError(err instanceof Error ? err.message : t("customRarity.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={handleClose}
    >
      <div
        className="max-h-[90vh] w-full max-w-lg overflow-hidden rounded-xl bg-gray-800 shadow-2xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* ヘッダー */}
        <div className="p-6 border-b border-gray-700">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-semibold text-white">
              {t("customRarity.title")}
            </h3>
            <button
              onClick={handleClose}
              className="text-gray-400 hover:text-white"
              aria-label="Close"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="h-6 w-6"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </button>
          </div>
          <p className="mt-2 text-sm text-gray-400">
            {t("customRarity.description")}
          </p>
          {isMaintenanceBlocked && (
            <p className="mt-2 text-sm text-yellow-400">{tMaintenance("writeDisabled")}</p>
          )}
        </div>

        {/* 本文 */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {/* デフォルト（読み取り専用・削除不可） */}
          <div>
            <h4 className="mb-2 text-sm font-medium text-gray-300">
              {t("customRarity.defaultSection")}
            </h4>
            <div className="flex flex-wrap gap-2">
              {RARITIES.map((r) => (
                <span
                  key={r.value}
                  className={`rounded-full px-3 py-1 text-sm text-white ${r.color}`}
                >
                  {tRarity(r.value)}
                </span>
              ))}
            </div>
          </div>

          {/* カスタム */}
          <div>
            <h4 className="mb-2 text-sm font-medium text-gray-300">
              {t("customRarity.customSection")}
            </h4>
            <div className="flex gap-2">
              <input
                type="text"
                value={input}
                maxLength={MAX_RARITY_KEY_LENGTH}
                placeholder={t("customRarity.addPlaceholder")}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  // CardPackModal (#613) と同種のIME誤送信バグの再発防止として、
                  // 同じガードをここにも適用する。
                  if (isEnterKeySubmit(e)) {
                    e.preventDefault();
                    handleAdd();
                  }
                }}
                className="w-full min-w-0 rounded-lg bg-gray-600 px-4 py-2 text-white placeholder:text-gray-400"
              />
              <button
                type="button"
                onClick={handleAdd}
                className="rounded-lg border border-purple-600 px-4 py-2 text-purple-400 hover:bg-purple-600 hover:text-white transition whitespace-nowrap"
              >
                {t("customRarity.add")}
              </button>
            </div>
            {error && (
              <p className="mt-2 text-sm text-red-400">{error}</p>
            )}

            <div className="mt-4">
              {list.length === 0 ? (
                <p className="text-sm text-gray-500">
                  {t("customRarity.empty")}
                </p>
              ) : (
                <ul className="space-y-3">
                  {list.map((value) => {
                    const style = styles[value];
                    const [gradientFrom, gradientTo] = parseGradientValue(
                      style?.gradient
                    );
                    const glow = parseGlowValue(style?.glow);
                    // Issue #2029: 編集中の見た目を実描画と同じ解決ロジック
                    // (getRarityStylePresentation) でプレビューする。未設定の
                    // プロパティはプリセット色へ倒れ、「既定」の見た目になる。
                    const preview = getRarityStylePresentation(value, stylesForList);
                    return (
                      <li
                        key={value}
                        className="space-y-3 rounded-lg bg-gray-700 px-4 py-3"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-white break-all">{value}</span>
                          <button
                            type="button"
                            onClick={() => handleRemove(value)}
                            className="text-gray-400 hover:text-red-400"
                            aria-label={`Remove ${value}`}
                          >
                            <svg
                              xmlns="http://www.w3.org/2000/svg"
                              className="h-5 w-5"
                              fill="none"
                              viewBox="0 0 24 24"
                              stroke="currentColor"
                            >
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={2}
                                d="M6 18L18 6M6 6l12 12"
                              />
                            </svg>
                          </button>
                        </div>

                        {/* Issue #2029: 保存前に見た目を確認するプレビュー。
                            左はコレクション/詳細のバッジ（文字色+グロー）、
                            右はオーバーレイのカード枠（グラデーション+グロー）。
                            shadow-md は影色クラス(shadow-[color:...])を可視化する幅。 */}
                        <div
                          className="flex items-center gap-3"
                          aria-label={t("customRarity.previewLabel", { rarity: value })}
                        >
                          <span
                            style={preview.styleVars}
                            className={`rounded-full px-3 py-1 text-sm text-white shadow-md ${preview.colorClass} ${preview.glowClass}`}
                          >
                            {value}
                          </span>
                          <span
                            style={preview.styleVars}
                            className={`inline-block rounded-lg bg-gradient-to-br p-0.5 shadow-md ${preview.gradientClass} ${preview.glowClass}`}
                          >
                            <span className="block h-6 w-10 rounded-md bg-gray-900" />
                          </span>
                        </div>

                        {/* 文字色 */}
                        <div className="flex items-center gap-2">
                          <span className="w-24 shrink-0 text-xs text-gray-300">
                            {t("customRarity.colorField")}
                          </span>
                          <input
                            type="color"
                            value={toColorInputValue(style?.color)}
                            onChange={(e) =>
                              updateRarityStyle(value, { color: e.target.value })
                            }
                            className="h-8 w-8 cursor-pointer rounded border border-gray-600 bg-transparent"
                            aria-label={t("customRarity.colorLabel", { rarity: value })}
                          />
                          {/* Issue #1783: 既定表示（gray）へ戻す手段を用意する。
                              未設定のスタイルは送らないので、キーごと落とす。 */}
                          {style?.color !== undefined && (
                            <button
                              type="button"
                              onClick={() => clearRarityStyleProp(value, "color")}
                              aria-label={t("customRarity.resetColorLabel", { rarity: value })}
                              className="rounded border border-gray-600 px-2 py-1 text-xs text-gray-300 hover:border-gray-400 hover:text-white transition"
                            >
                              {t("customRarity.clearColor")}
                            </button>
                          )}
                        </div>

                        {/* Issue #2029: グラデーション（from/to の2色）。片方だけ
                            設定しても描画側は from/to 両方必要なため、ここでも
                            必ず "#rrggbb,#rrggbb" のペアで保存する。 */}
                        <div className="flex items-center gap-2">
                          <span className="w-24 shrink-0 text-xs text-gray-300">
                            {t("customRarity.gradientField")}
                          </span>
                          <input
                            type="color"
                            value={gradientFrom}
                            onChange={(e) =>
                              updateRarityStyle(value, {
                                gradient: `${e.target.value},${gradientTo}`,
                              })
                            }
                            className="h-8 w-8 cursor-pointer rounded border border-gray-600 bg-transparent"
                            aria-label={t("customRarity.gradientFromLabel", { rarity: value })}
                          />
                          <input
                            type="color"
                            value={gradientTo}
                            onChange={(e) =>
                              updateRarityStyle(value, {
                                gradient: `${gradientFrom},${e.target.value}`,
                              })
                            }
                            className="h-8 w-8 cursor-pointer rounded border border-gray-600 bg-transparent"
                            aria-label={t("customRarity.gradientToLabel", { rarity: value })}
                          />
                          {style?.gradient !== undefined && (
                            <button
                              type="button"
                              onClick={() => clearRarityStyleProp(value, "gradient")}
                              aria-label={t("customRarity.resetGradientLabel", { rarity: value })}
                              className="rounded border border-gray-600 px-2 py-1 text-xs text-gray-300 hover:border-gray-400 hover:text-white transition"
                            >
                              {t("customRarity.clearColor")}
                            </button>
                          )}
                        </div>

                        {/* Issue #2029: グロー（色 + 不透明度）。不透明度は
                            #RRGGBBAA のアルファとして保存する（100%は #RRGGBB）。 */}
                        <div className="flex items-center gap-2">
                          <span className="w-24 shrink-0 text-xs text-gray-300">
                            {t("customRarity.glowField")}
                          </span>
                          <input
                            type="color"
                            value={glow.color}
                            onChange={(e) =>
                              updateRarityStyle(value, {
                                glow: composeGlowValue(e.target.value, glow.opacity),
                              })
                            }
                            className="h-8 w-8 cursor-pointer rounded border border-gray-600 bg-transparent"
                            aria-label={t("customRarity.glowLabel", { rarity: value })}
                          />
                          <input
                            type="range"
                            min={0}
                            max={100}
                            step={5}
                            value={glow.opacity}
                            onChange={(e) =>
                              updateRarityStyle(value, {
                                glow: composeGlowValue(
                                  glow.color,
                                  Number(e.target.value)
                                ),
                              })
                            }
                            className="h-2 w-20 cursor-pointer accent-purple-500"
                            aria-label={t("customRarity.glowOpacityLabel", { rarity: value })}
                          />
                          <span className="w-9 text-right text-xs text-gray-400">
                            {glow.opacity}%
                          </span>
                          {style?.glow !== undefined && (
                            <button
                              type="button"
                              onClick={() => clearRarityStyleProp(value, "glow")}
                              aria-label={t("customRarity.resetGlowLabel", { rarity: value })}
                              className="rounded border border-gray-600 px-2 py-1 text-xs text-gray-300 hover:border-gray-400 hover:text-white transition"
                            >
                              {t("customRarity.clearColor")}
                            </button>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            <p className="mt-3 text-xs text-gray-500">
              {t("customRarity.deleteNote")}
            </p>
          </div>
        </div>

        {/* フッター */}
        <div className="p-6 border-t border-gray-700 flex justify-end">
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || !hasChanges || isMaintenanceBlocked}
            title={isMaintenanceBlocked ? tMaintenance("writeDisabled") : undefined}
            className="rounded-lg bg-purple-600 px-6 py-2 text-white hover:bg-purple-700 transition disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saving ? t("customRarity.saving") : t("customRarity.save")}
          </button>
        </div>
      </div>
    </div>
  );
}
