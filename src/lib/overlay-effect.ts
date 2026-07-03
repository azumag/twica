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

/**
 * Issue #587: sparkle/confetti/hearts が全て同じ「上下バウンス」アニメーションを
 * 共有していたため、紙吹雪もハートも見た目だけ差し替えた虫のような動きになっていた。
 * スタイルごとに「どこから出現し、どう動くか」を明確に区別するための設定を
 * ここに集約する（overlay page が唯一の描画元。OverlayPreview は overlay page を
 * iframe で埋め込んでプレビューしているため、この設定を直接参照しなくても
 * 自動的に本番と同じ見た目になる）。
 *
 * - sparkle: 画面全体にランダム出現し、Tailwind 組み込みの animate-ping
 *   （拡大しながらフェードアウト）を使う既存の見た目を完全維持する（回帰防止）。
 * - confetti: カード上部付近から出現し、左右に揺れながら回転して落下する
 *   「紙吹雪」らしい動き（globals.css の overlay-confetti-fall keyframes）。
 * - hearts: カード下部/側面付近から出現し、左右に揺れながら拡大→縮小しつつ
 *   上に浮かび上がる「ハートが舞い上がる」動き（globals.css の
 *   overlay-hearts-float keyframes）。
 */
export interface OverlayEffectParticleConfig {
  /** globals.css で定義されたアニメーションを適用する CSS クラス名 */
  animationClassName: string;
  /** パーティクル出現位置の left(%) 範囲 [min, max]（100 を超える/0未満の値も許容し、はみ出した状態から出現させられる） */
  spawnLeftPercentRange: readonly [number, number];
  /** パーティクル出現位置の top(%) 範囲 [min, max] */
  spawnTopPercentRange: readonly [number, number];
  /** 1周期のアニメーション所要秒数の範囲 [min, max] */
  durationSecRange: readonly [number, number];
  /** アニメーション開始遅延秒数の範囲 [min, max] */
  delaySecRange: readonly [number, number];
}

/** overlay page が1回のエフェクト表示で生成するパーティクル数（既存挙動を維持し変更しない） */
export const OVERLAY_EFFECT_PARTICLE_COUNT = 20;

export const OVERLAY_EFFECT_PARTICLE_CONFIG: Readonly<Record<OverlayEffectStyle, OverlayEffectParticleConfig>> = {
  sparkle: {
    animationClassName: "animate-ping",
    spawnLeftPercentRange: [0, 100],
    spawnTopPercentRange: [0, 100],
    durationSecRange: [1, 2],
    delaySecRange: [0, 2],
  },
  confetti: {
    animationClassName: "animate-overlay-effect-confetti",
    // 紙吹雪はカード上端付近（画面上端よりわずかに上も含む）から降り始める
    spawnLeftPercentRange: [0, 100],
    spawnTopPercentRange: [-8, 8],
    durationSecRange: [2.2, 3.6],
    delaySecRange: [0, 2.4],
  },
  hearts: {
    animationClassName: "animate-overlay-effect-hearts",
    // ハートはカード下部〜側面付近から浮かび上がる
    spawnLeftPercentRange: [0, 100],
    spawnTopPercentRange: [50, 100],
    durationSecRange: [2.6, 4.2],
    delaySecRange: [0, 2.4],
  },
} as const;

export interface OverlayEffectParticle {
  left: string;
  top: string;
  animationDelay: string;
  animationDuration: string;
}

function randomInRange([min, max]: readonly [number, number]): number {
  return min + Math.random() * (max - min);
}

/**
 * 指定スタイルのパーティクル出現位置・タイミングを生成する。
 * left/top はスタイルごとの出現エリア（OVERLAY_EFFECT_PARTICLE_CONFIG）からランダムに、
 * animationDelay/animationDuration もスタイルごとの範囲からランダムに決め、
 * 20個が完全に同期して動く「機械的」な見た目にならないようにする。
 */
export function generateOverlayEffectParticles(
  style: OverlayEffectStyle,
  count: number,
): OverlayEffectParticle[] {
  const config = OVERLAY_EFFECT_PARTICLE_CONFIG[style];
  return Array.from({ length: count }, () => ({
    left: `${randomInRange(config.spawnLeftPercentRange).toFixed(2)}%`,
    top: `${randomInRange(config.spawnTopPercentRange).toFixed(2)}%`,
    animationDelay: `${randomInRange(config.delaySecRange).toFixed(2)}s`,
    animationDuration: `${randomInRange(config.durationSecRange).toFixed(2)}s`,
  }));
}
