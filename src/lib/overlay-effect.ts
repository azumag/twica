/**
 * Overlay effect style: shared single source of truth.
 * オーバーレイエフェクト種別をクライアント／コンポーネント間で共有し、
 * 値・型・バリデーションロジックの重複を防ぐ。
 *
 * 値追加時は OVERLAY_EFFECT_STYLES に足すだけで OverlayPreview / overlay page 両方に反映される。
 */
export type OverlayEffectStyle = "sparkle" | "confetti" | "hearts";

export const OVERLAY_EFFECT_STYLES: readonly OverlayEffectStyle[] = ["sparkle", "confetti", "hearts"];

export const DEFAULT_OVERLAY_EFFECT_STYLE: OverlayEffectStyle = "sparkle";

function isOverlayEffectStyle(value: unknown): value is OverlayEffectStyle {
  return typeof value === "string" && (OVERLAY_EFFECT_STYLES as readonly string[]).includes(value);
}

/**
 * URLクエリ・localStorage・任意ユーザー入力を許容入力として受け取り、
 * OverlayEffectStyle のいずれかに正規化する。未知の値は DEFAULT に丸める。
 */
export function normalizeOverlayEffectStyle(value: unknown): OverlayEffectStyle {
  return isOverlayEffectStyle(value) ? value : DEFAULT_OVERLAY_EFFECT_STYLE;
}
