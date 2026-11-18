import { MAX_RARITY_KEY_LENGTH } from "./constants";
import { RARITY_STYLE_CSS_VARS } from "./rarity";
import { TAILWIND_PALETTE_HEX } from "./tailwind-palette";

/**
 * Overlay effect style: shared single source of truth.
 * オーバーレイのガチャ演出（レアリティ別エフェクト）に関する型・定数・
 * パーティクル生成ロジックをここに集約し、overlay page / OverlayPreview の
 * 双方で同じ定義を使う（値・型・バリデーションの重複を防ぐ）。
 *
 * 設計方針（Issue: レジェンダリーエフェクト品質改善）:
 * - 種類を増やす: sparkle/confetti/hearts に加え fireworks/stars/bubbles/
 *   petals/snow/coins を追加し、"none"（演出なし）も1つのスタイルとして扱う。
 * - 品質を上げる: 従来はパーティクルごとに left/top/delay/duration しか
 *   ランダム化しておらず、20個が同一の軌道・色・サイズで動くため「機械的」
 *   だった。本実装では各パーティクルに固有の CSS カスタムプロパティ
 *   （--fx-fall / --fx-sway / --fx-rot など）と色・サイズ・形状を持たせ、
 *   globals.css のキーフレームがそれを参照することで、1つの演出内でも
 *   自然なばらつき（揺れ幅・回転量・落下距離・色）を生む。
 * - レアリティ紐付け: 単一の effectStyle ではなく「レアリティ→スタイル」の
 *   マップ（RarityEffectMap）で表現し、OBS URL の `fx=` パラメータに符号化する。
 * - 開始位相: globals.css の animate-* は `animation-fill-mode` を指定しない
 *   （= none）ため、正の delay を持つ粒子は遅延中にアニメーションが適用されず、
 *   inline の opacity 未指定のまま「不透明で静止」する。表示直後は全粒子が
 *   この状態になり、短い表示時間では一度も動かない粒子が残る。これを避けるため
 *   環境系8種は「duration を先に決め、-[0, duration) の負の delay を付ける」
 *   ことで表示開始時点で必ず周期の途中に置く。バーストの同時性を優先する
 *   fireworks だけは正の delay を残し、CSS 側の `fill-mode: backwards` で
 *   開始前を透明にする。
 *
 * 描画は overlay page が唯一の実体。OverlayPreview は overlay page を iframe で
 * 埋め込んでプレビューするため、この設定を直接参照しなくても本番と同じ見た目になる。
 */

/**
 * エフェクトスタイル。"none" は「演出なし」を表す正規の値で、レアリティ別
 * マップで「このレアリティには何も出さない」を表現するために用いる。
 */
export type OverlayEffectStyle =
  | "none"
  | "sparkle"
  | "confetti"
  | "hearts"
  | "fireworks"
  | "stars"
  | "bubbles"
  | "petals"
  | "snow"
  | "coins"
  | "aura";

/**
 * 設定 UI（OverlayPreview）でレアリティごとに選べるスタイルの一覧（＝表示順）。
 * 先頭の "none"（演出なし）はレアリティ別に演出を切りたい場合の選択肢。
 */
export const OVERLAY_EFFECT_STYLES: readonly OverlayEffectStyle[] = [
  "none",
  "sparkle",
  "confetti",
  "hearts",
  "fireworks",
  "stars",
  "bubbles",
  "petals",
  "snow",
  "coins",
  "aura",
];

/**
 * 実際にパーティクルを描画するスタイル（"none" を除く）。
 * OVERLAY_EFFECT_STYLES から派生させ、リストの二重管理を避ける
 * （OVERLAY_EFFECT_PARTICLE_CONFIG のキー集合と一致する）。
 */
export const ANIMATED_OVERLAY_EFFECT_STYLES: readonly Exclude<OverlayEffectStyle, "none">[] =
  OVERLAY_EFFECT_STYLES.filter(
    (style): style is Exclude<OverlayEffectStyle, "none"> => style !== "none",
  );

/**
 * レガシー単一 effect= パラメータ／未知入力を正規化するときのフォールバック。
 * 既存挙動（effect 未指定時は sparkle）を維持する。
 */
export const DEFAULT_OVERLAY_EFFECT_STYLE: OverlayEffectStyle = "sparkle";

export function isOverlayEffectStyle(value: unknown): value is OverlayEffectStyle {
  return typeof value === "string" && (OVERLAY_EFFECT_STYLES as readonly string[]).includes(value);
}

/**
 * URLクエリ・localStorage・任意ユーザー入力を許容入力として受け取り、
 * OverlayEffectStyle のいずれかに正規化する。未知の値は DEFAULT に丸める。
 */
export function normalizeOverlayEffectStyle(value: unknown): OverlayEffectStyle {
  return isOverlayEffectStyle(value) ? value : DEFAULT_OVERLAY_EFFECT_STYLE;
}

/* -------------------------------------------------------------------------- */
/* レイヤーのカード外はみ出し量（Issue #2088 (2) カード外へのはみ出し）             */
/* -------------------------------------------------------------------------- */

/**
 * 粒子レイヤーをカードの外側へ何 px 拡げるか。
 *
 * overlay page は粒子レイヤーを `inset: -N px` の箱（カードより一回り大きい
 * 領域）に置き、レイヤー自身の `overflow: hidden` でその箱の縁にクリップする。
 * これにより「カードの縁で粒子が途中切れする」代わりに「カードの背後から
 * 粒子が外へはみ出して見える」演出になる。N が大きすぎると OBS の表示領域
 * （800x600 を想定）から粒子が画面外へ消えて見えなくなるため、実測した
 * 800x600 での上下余白 76px を超えない範囲（目安 48〜64px）から 56 を選ぶ。
 *
 * DOM 順でカードより前に置く（＝背面）前提の値で、カード全面を覆う
 * 前面配置と違って「縁から覗く」量としてちょうどよい幅になっている。
 */
export const OVERLAY_EFFECT_OVERFLOW_PX = 56;

/* -------------------------------------------------------------------------- */
/* レアリティ → エフェクトのマッピング                                          */
/* -------------------------------------------------------------------------- */

/** レアリティ名（"legendary" 等、カスタムレアリティ名も可）→ スタイル */
export type RarityEffectMap = Record<string, OverlayEffectStyle>;

/**
 * 設定 UI で扱うビルトインレアリティの既定エフェクト。
 *
 * 既存挙動の非破壊維持がねらい: 従来はエフェクトが legendary にのみ表示され、
 * 既定スタイルは sparkle だった。そのため common/rare/epic は "none"、
 * legendary のみ "sparkle" を既定とする。配信者は必要に応じて各レアリティへ
 * 演出を割り当てられる（レアリティ紐付け）。
 */
export const DEFAULT_BUILTIN_RARITY_EFFECTS: Readonly<Record<"common" | "rare" | "epic" | "legendary", OverlayEffectStyle>> = {
  common: "none",
  rare: "none",
  epic: "none",
  legendary: "sparkle",
};

/**
 * URL に `fx=` が無く、レガシー `effect=` も無い場合に用いる既定マップ。
 * DEFAULT_BUILTIN_RARITY_EFFECTS から "none" でないものだけを抽出して導出する
 * （= legendary: sparkle）。手書きの二重管理を避け、既定値の変更が両方の
 * 定数に自動で反映されるようにする。resolveEffectForRarity は未登録レアリティを
 * "none" とみなすため、これで「legendary のみ sparkle」を表現できる。
 */
export const DEFAULT_RARITY_EFFECT_MAP: RarityEffectMap = Object.fromEntries(
  Object.entries(DEFAULT_BUILTIN_RARITY_EFFECTS).filter(([, style]) => style !== "none"),
);

/** 全レアリティ演出オフを表す `fx=` のセンチネル値（曖昧な空文字を避ける） */
const RARITY_EFFECT_MAP_OFF_SENTINEL = "off";

/**
 * レアリティ別マップから、指定レアリティで再生すべきスタイルを解決する。
 * マップに無いレアリティ（カスタムレアリティ含む）は "none"（演出なし）。
 */
export function resolveEffectForRarity(map: RarityEffectMap, rarity: string): OverlayEffectStyle {
  const style = map[rarity];
  return style && isOverlayEffectStyle(style) ? style : "none";
}

/**
 * レアリティ別マップを URL パラメータ文字列（`fx=` の値）に符号化する。
 *
 * - "none" のレアリティは省略する（未列挙＝none というデコード規約のため短くできる）。
 * - 演出が1つも無い（全レアリティ none）場合は "off" を返す（空文字だと
 *   `fx=` が生成され曖昧・環境によって欠落しうるため、明示的センチネルを使う）。
 *
 * レアリティ名は `,` `:` を区切り文字として使うため encodeURIComponent で
 * エスケープする（カスタムレアリティ名にこれらの文字が含まれても壊れないように）。
 * スタイル値は OVERLAY_EFFECT_STYLES の固定集合なので区切り文字を含まずエスケープ不要。
 *
 * 例: { epic:"confetti", legendary:"fireworks" } → "epic:confetti,legendary:fireworks"
 */
export function serializeRarityEffectMap(map: RarityEffectMap): string {
  const pairs = Object.entries(map)
    .filter(([, style]) => style !== "none" && isOverlayEffectStyle(style))
    .map(([rarity, style]) => `${encodeURIComponent(rarity)}:${style}`);
  return pairs.length > 0 ? pairs.join(",") : RARITY_EFFECT_MAP_OFF_SENTINEL;
}

/** 攻撃的な入力でマップが肥大化しないための上限（ビルトイン4種＋カスタム分の余裕）。 */
const MAX_RARITY_EFFECT_ENTRIES = 60;

/**
 * `fx=` の値をレアリティ別マップにデコードする。
 * "off"／空文字は「全レアリティ演出なし」（空マップ）。
 * 不正なペア（レアリティ名が長すぎる/空、デコード不能、未知スタイル）はスキップする
 * （未知スタイルを sparkle 等に丸めると誤爆するため、その項目自体を無視する）。
 */
function deserializeRarityEffectMap(fxValue: string): RarityEffectMap {
  // split 前に入力長を制限しておく（防御的: 極端に長い値の split を避ける。
  // 実用上は「レアリティ名:スタイル」× 数十件で十分収まる長さ。encodeURIComponent は
  // 文字数を増やす方向にしか働かないため、この上限でデコード後の正当な値を誤って
  // 切り詰めることはない）。
  const trimmed = fxValue.trim().slice(0, MAX_RARITY_EFFECT_ENTRIES * (MAX_RARITY_KEY_LENGTH * 3 + 16));
  if (trimmed === "" || trimmed === RARITY_EFFECT_MAP_OFF_SENTINEL) {
    return {};
  }

  const map: RarityEffectMap = {};
  // 最大でも上限件数分のペアだけを処理する（split の第2引数で要素数を制限）。
  const pairs = trimmed.split(",", MAX_RARITY_EFFECT_ENTRIES);
  for (const pair of pairs) {
    if (Object.keys(map).length >= MAX_RARITY_EFFECT_ENTRIES) break;
    const separatorIndex = pair.indexOf(":");
    if (separatorIndex <= 0) continue;
    const style = pair.slice(separatorIndex + 1).trim();
    let rarity: string;
    try {
      rarity = decodeURIComponent(pair.slice(0, separatorIndex).trim());
    } catch {
      // 不正な %エンコーディングはこのペアごとスキップする
      continue;
    }
    if (rarity.length === 0 || rarity.length > MAX_RARITY_KEY_LENGTH) continue;
    // 未知スタイルは丸めずスキップ（isOverlayEffectStyle は "none" も真だが、
    // 明示 none は演出なしとして受理してよい）
    if (!isOverlayEffectStyle(style)) continue;
    map[rarity] = style;
  }
  return map;
}

/**
 * overlay page 用: URL の `fx`（新方式）と `effect`（レガシー方式）から
 * レアリティ別マップを構築する。
 *
 * 優先順位:
 * 1. `fx` がある → それを完全なマップとして採用（未列挙レアリティは none）。
 * 2. `fx` は無いが `effect` がある → レガシー挙動（legendary にのみそのスタイル）。
 *    既存の配信者が OBS に設定済みの `?effect=confetti` 等の URL を壊さないため。
 * 3. どちらも無い → 既定（legendary: sparkle）。
 */
export function parseRarityEffectMap(
  fxParam: string | null,
  legacyEffectParam: string | null,
): RarityEffectMap {
  if (fxParam !== null) {
    return deserializeRarityEffectMap(fxParam);
  }
  if (legacyEffectParam !== null) {
    return { legendary: normalizeOverlayEffectStyle(legacyEffectParam) };
  }
  return { ...DEFAULT_RARITY_EFFECT_MAP };
}

/* -------------------------------------------------------------------------- */
/* パーティクル設定・生成                                                        */
/* -------------------------------------------------------------------------- */

/**
 * 1パーティクルの「見た目」。overlay page はこれを汎用的にそのまま描画するため、
 * スタイルごとの分岐（従来の if (confetti) ... else if (hearts) ...）を持たない。
 */
export interface OverlayEffectParticlePresentation {
  /** 要素内に表示するグリフ（♥ など）。CSS で描く形状の場合は空文字。 */
  content: string;
  /**
   * インラインスタイル。色・サイズ・box-shadow・clip-path・border-radius などの
   * 見た目と、キーフレームが参照する per-particle の CSS カスタムプロパティ
   * （--fx-fall / --fx-sway / --fx-rot 等）を含む。
   */
  visualStyle: Record<string, string | number>;
  /**
   * 出現位置・遅延の上書き（任意）。複数パーティクルが位置・タイミングを
   * 共有する必要がある演出（例: fireworks は数個の共通中心から破裂させる）で使う。
   * 未指定ならスタイルの spawn/delay 範囲からランダムに決まる。
   */
  left?: string;
  top?: string;
  /**
   * 開始遅延（秒）の上書き。負値は「周期の途中から開始」を意味する。
   * CSS では `animation-delay: -0.4s` のように負の time として出力される。
   */
  delaySec?: number;
  /**
   * 1周期（秒）の上書き。同じ開始時刻を共有する粒子に同じ速さを与えたい
   * 演出（fireworks のバースト）で使う。
   */
  durationSec?: number;
}

/** スタイルごとのパーティクル生成設定 */
export interface OverlayEffectParticleConfig {
  /** globals.css で定義されたアニメーションを適用する CSS クラス名 */
  animationClassName: string;
  /** 出現位置の left(%) 範囲 [min, max]（100超/0未満も許容し、画面外から出現可） */
  spawnLeftPercentRange: readonly [number, number];
  /** 出現位置の top(%) 範囲 [min, max] */
  spawnTopPercentRange: readonly [number, number];
  /** 1周期の所要秒数の範囲 [min, max] */
  durationSecRange: readonly [number, number];
  /**
   * 正の delay を使うスタイルの開始遅延秒数の範囲 [min, max]。
   * `startAtRandomPhase: true` のスタイルでは参照しない（負の delay を算出する）ため
   * 省略する。省略された場合は delay 0（即時開始）にフォールバックする。
   */
  delaySecRange?: readonly [number, number];
  /**
   * true: 粒子ごとに duration を先に決め、その範囲内の**負の** delay を付ける。
   * 表示開始時点で必ず周期の途中にいるため、fill-mode: none でも
   * 「不透明なまま静止する」フレームが生じない（環境系8種が該当）。
   * false/未指定: delaySecRange から正の delay を選ぶ（fireworks のバースト等）。
   */
  startAtRandomPhase?: boolean;
  /** このスタイルの既定パーティクル数（花火/雪など密度が要るものは多めにする） */
  particleCount: number;
  /** index からこのパーティクル固有の見た目（色・サイズ・軌道パラメータ）を生成する */
  buildParticle: (index: number) => OverlayEffectParticlePresentation;
}

/* ---- 生成ヘルパ（自然なばらつきのための乱数ユーティリティ） ---- */
function rand(min: number, max: number): number {
  return randomInRange([min, max]);
}
function pick<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}
function px(value: number): string {
  return `${value.toFixed(1)}px`;
}
function deg(value: number): string {
  return `${value.toFixed(1)}deg`;
}

/* ---- スタイル別カラーパレット（複数色でばらつきを出す） ---- */
const CONFETTI_COLORS = ["#fbbf24", "#f472b6", "#22d3ee", "#a78bfa", "#34d399", "#fb7185", "#facc15"];
const HEART_COLORS = ["#fb7185", "#f472b6", "#f9a8d4", "#ef4444", "#ec4899"];
const SPARKLE_COLORS = ["#fde68a", "#fef3c7", "#ffffff", "#fcd34d", "#fbbf24"];
const FIREWORK_COLORS = ["#f87171", "#fbbf24", "#34d399", "#60a5fa", "#c084fc", "#f472b6", "#fde047"];
const STAR_COLORS = ["#ffffff", "#fde68a", "#bae6fd"];
const PETAL_COLORS = ["#fbcfe8", "#f9a8d4", "#fda4af", "#fecdd3"];
const COIN_COLORS = ["#fde047", "#facc15", "#fbbf24"];

/** 4方向にとがったキラキラ星形の clip-path（sparkle 用） */
const SPARKLE_STAR_CLIP =
  "polygon(50% 0%, 61% 39%, 100% 50%, 61% 61%, 50% 100%, 39% 61%, 0% 50%, 39% 39%)";

/**
 * 花火のバースト周期（秒）。全バーストで共通。
 *
 * 同じバーストの火花へ同じ delaySec / durationSec を与えるため、乱数ではなく
 * 固定テーブルにしている。粒子ごとに duration を乱数化すると、同じ中心から
 * 同時に出た火花の到達距離と消える瞬間がばらけ、「1点から破裂して広がる」形が
 * 崩れて散発的な点の集まりに見える。ランダム性は火花ごとの放射角・距離・色・
 * サイズと、中心の±2%ジッターで担保する。
 *
 * 周期を全バーストで揃え、開始時刻を period/4 ずつ等間隔に置くのは、
 * 「全バーストが同時に暗転して画面から火花が消える時間帯」を無くすため。
 * overlay-effect-fireworks のキーフレームは 60% で opacity 1、100% で 0 に
 * なるので、opacity が 0.3 を下回るのは周期の約12%（末尾 0.216s）。開始時刻を
 * 0.45s 間隔にすれば暗い区間が重ならず、常に3バースト以上が明るい状態を保てる。
 * 周期をバーストごとに変えると、位相がずれて全バーストが同時に暗転する瞬間が
 * 周期的に現れる（実測: 6秒表示の 4.3s 付近で最大 opacity 0.17 まで低下）。
 */
const FIREWORK_BURST_PERIOD_SEC = 1.8;

/**
 * バーストの中心（%）と開始時刻（秒）。
 * 中心は spawnLeft [20,80] / spawnTop [12,48] の内側に置く。
 * delaySec は 0.05 + period/4 × index（= 0.45s 間隔）。
 */
const FIREWORK_BURSTS: readonly {
  center: readonly [number, number];
  delaySec: number;
}[] = [
  { center: [34, 24], delaySec: 0.05 },
  { center: [66, 30], delaySec: 0.5 },
  { center: [50, 20], delaySec: 0.95 },
  { center: [46, 42], delaySec: 1.4 },
];

/**
 * スタイルごとの設定。animationClassName は globals.css の @theme inline で
 * 定義した animate-* ユーティリティ名（キーフレーム overlay-effect-<style>）。
 *
 * `startAtRandomPhase: true` を付けた環境系8種（sparkle / confetti / hearts /
 * stars / bubbles / petals / snow / coins）は、粒子ごとに duration を先に決めて
 * -[0, duration) の負の delay を付ける。正の delay のままだと、遅延中は
 * アニメーション未適用（fill-mode: none）× inline opacity 未指定となり、
 * 粒子が不透明のまま静止して見えるため。fireworks はバーストの同時性を優先して
 * 正の delay を保ち、CSS の fill-mode: backwards で開始前を透明にする。
 * aura は負の delay のみ（縁の炎が常時燃え続ける位相ずらし）なので対象外。
 */
export const OVERLAY_EFFECT_PARTICLE_CONFIG: Readonly<
  Record<Exclude<OverlayEffectStyle, "none">, OverlayEffectParticleConfig>
> = {
  // キラキラ: 画面全体にきらめく星形が明滅する（回転＋拡縮＋発光）
  sparkle: {
    animationClassName: "animate-overlay-effect-sparkle",
    spawnLeftPercentRange: [0, 100],
    spawnTopPercentRange: [0, 100],
    durationSecRange: [1.1, 2.2],
    startAtRandomPhase: true,
    particleCount: 22,
    buildParticle: () => {
      const size = rand(6, 16);
      const color = pick(SPARKLE_COLORS);
      return {
        content: "",
        visualStyle: {
          width: px(size),
          height: px(size),
          backgroundColor: color,
          clipPath: SPARKLE_STAR_CLIP,
          boxShadow: `0 0 ${px(size * 0.8)} ${color}`,
          "--fx-scale": rand(0.8, 1.4).toFixed(2),
          "--fx-rot": deg(rand(60, 200)),
        },
      };
    },
  },

  // 紙吹雪: カード上端付近から出現し、左右に揺れながら3D回転して落下する
  confetti: {
    animationClassName: "animate-overlay-effect-confetti",
    spawnLeftPercentRange: [0, 100],
    spawnTopPercentRange: [-8, 8],
    durationSecRange: [2.4, 3.8],
    startAtRandomPhase: true,
    particleCount: 26,
    buildParticle: (index) => {
      const color = pick(CONFETTI_COLORS);
      // 半々でリボン（縦長矩形）と丸を混ぜて紙吹雪らしい多様性を出す
      const isRibbon = index % 2 === 0;
      const width = isRibbon ? rand(4, 7) : rand(7, 10);
      const height = isRibbon ? rand(10, 16) : width;
      return {
        content: "",
        visualStyle: {
          width: px(width),
          height: px(height),
          backgroundColor: color,
          borderRadius: isRibbon ? "1px" : "50%",
          "--fx-fall": px(rand(240, 360)),
          "--fx-sway": px(rand(10, 30)),
          "--fx-spin": deg(rand(360, 960)),
        },
      };
    },
  },

  // ハート: カード下部/側面から左右に揺れつつ拡縮しながら浮かび上がる
  hearts: {
    animationClassName: "animate-overlay-effect-hearts",
    spawnLeftPercentRange: [0, 100],
    spawnTopPercentRange: [50, 100],
    durationSecRange: [2.6, 4.2],
    startAtRandomPhase: true,
    particleCount: 20,
    buildParticle: () => {
      const size = rand(14, 30);
      const color = pick(HEART_COLORS);
      return {
        content: "♥",
        visualStyle: {
          color,
          fontSize: px(size),
          lineHeight: "1",
          textShadow: `0 0 ${px(size * 0.35)} ${color}88`,
          "--fx-rise": px(rand(180, 300)),
          "--fx-sway": px(rand(8, 22)),
          "--fx-scale": rand(0.9, 1.3).toFixed(2),
        },
      };
    },
  },

  // 花火: 複数の共通中心（バースト）から放射状に飛び散り、重力で少し落ちながら消える火花。
  // 各パーティクルは1個の火花で、同じバーストに属する火花は出現位置・開始時刻・周期を
  // 共有する（buildParticle が left/top/delaySec/durationSec を上書きする）。これにより
  // 「1点から破裂する花火」らしく見える（レビュー指摘: 独立した出現点だと散発的な
  // 火花に見えてしまう）。バースト位置は固定＋微ジッターで、常に spawn 範囲内に収める。
  fireworks: {
    animationClassName: "animate-overlay-effect-fireworks",
    spawnLeftPercentRange: [20, 80],
    spawnTopPercentRange: [12, 48],
    durationSecRange: [1.1, 1.9],
    delaySecRange: [0, 2.6],
    // 4バースト × 12火花 = 48。バースト単位でまとまるよう割り切れる数にする。
    particleCount: 48,
    buildParticle: (index) => {
      const sparksPerBurst = 12;
      const burstIndex = Math.floor(index / sparksPerBurst) % FIREWORK_BURSTS.length;
      const burst = FIREWORK_BURSTS[burstIndex];

      const size = rand(3, 6);
      const color = pick(FIREWORK_COLORS);
      // 放射方向をランダムな角度・距離で決め、--fx-dx/--fx-dy に格納する
      const angle = rand(0, Math.PI * 2);
      const radius = rand(60, 150);
      return {
        content: "",
        // 同じバーストの火花は同一中心（±微ジッター）から、同じ時刻に同じ速さで破裂する
        left: `${(burst.center[0] + rand(-2, 2)).toFixed(2)}%`,
        top: `${(burst.center[1] + rand(-2, 2)).toFixed(2)}%`,
        delaySec: burst.delaySec,
        durationSec: FIREWORK_BURST_PERIOD_SEC,
        visualStyle: {
          width: px(size),
          height: px(size),
          backgroundColor: color,
          borderRadius: "50%",
          boxShadow: `0 0 ${px(size * 1.6)} ${color}`,
          "--fx-dx": px(Math.cos(angle) * radius),
          "--fx-dy": px(Math.sin(angle) * radius),
        },
      };
    },
  },

  // 流れ星: 尾を引く光の筋が斜めに横切る。
  // Issue #2088 (2): 粒子レイヤーがカード外へ OVERLAY_EFFECT_OVERFLOW_PX だけ
  // はみ出す箱にクリップされるのに対し、従来の stars は尾+移動量で最大
  // 252.7px も突出し、クリップ境界で筋が断ち切れて見えた。専用の扱いとして
  // 出現位置を左上寄りに寄せ（spawnLeft [-8,40] / spawnTop [0,45]）、尾の長さを
  // [45,85]、移動量を dx [100,170] / dy [55,120] に縮める。標準カード
  // （w-80 ≒ 320px、レイヤー幅 432px）での最右翼端到達点は
  // 0.40*432 + 170 + 85*cosθ ≒ 415px < 432px（= カード右端 376px + 56px）で、
  // カード外へ最大約 39px はみ出しつつクリップ境界内に収まる。
  stars: {
    animationClassName: "animate-overlay-effect-stars",
    spawnLeftPercentRange: [-8, 40],
    spawnTopPercentRange: [0, 45],
    durationSecRange: [1.3, 2.3],
    startAtRandomPhase: true,
    particleCount: 16,
    buildParticle: () => {
      const length = rand(45, 85);
      const color = pick(STAR_COLORS);
      // 進行方向（右下がり）へ移動。角度から見た目の回転も一致させる
      const dx = rand(100, 170);
      const dy = rand(55, 120);
      const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
      return {
        content: "",
        visualStyle: {
          width: px(length),
          height: "2px",
          borderRadius: "2px",
          // 先端（右側）に向かって明るくなる尾
          backgroundImage: `linear-gradient(90deg, transparent, ${color})`,
          boxShadow: `0 0 6px ${color}`,
          "--fx-dx": px(dx),
          "--fx-dy": px(dy),
          "--fx-angle": deg(angle),
        },
      };
    },
  },

  // シャボン玉: 半透明の玉がゆらゆら揺れながら上昇する
  bubbles: {
    animationClassName: "animate-overlay-effect-bubbles",
    spawnLeftPercentRange: [0, 100],
    spawnTopPercentRange: [55, 100],
    durationSecRange: [3.0, 5.0],
    startAtRandomPhase: true,
    particleCount: 24,
    buildParticle: () => {
      const size = rand(10, 34);
      return {
        content: "",
        visualStyle: {
          width: px(size),
          height: px(size),
          borderRadius: "50%",
          // 左上にハイライトのある透明な玉
          backgroundImage:
            "radial-gradient(circle at 32% 28%, rgba(255,255,255,0.9), rgba(255,255,255,0.15) 42%, rgba(191,219,254,0.12) 70%)",
          border: "1px solid rgba(255,255,255,0.55)",
          boxShadow: "0 0 6px rgba(186,230,253,0.5)",
          "--fx-rise": px(rand(200, 340)),
          "--fx-sway": px(rand(10, 26)),
        },
      };
    },
  },

  // 花びら（桜）: ピンクの花びらが回転・横揺れしながら舞い落ちる
  petals: {
    animationClassName: "animate-overlay-effect-petals",
    spawnLeftPercentRange: [0, 100],
    spawnTopPercentRange: [-8, 8],
    durationSecRange: [3.0, 4.8],
    startAtRandomPhase: true,
    particleCount: 28,
    buildParticle: () => {
      const width = rand(9, 15);
      const height = width * rand(0.7, 0.9);
      const color = pick(PETAL_COLORS);
      return {
        content: "",
        visualStyle: {
          width: px(width),
          height: px(height),
          backgroundColor: color,
          // 花びららしい非対称の丸み
          borderRadius: "150% 0 150% 0",
          boxShadow: `0 0 2px ${color}`,
          "--fx-fall": px(rand(240, 360)),
          "--fx-sway": px(rand(14, 34)),
          "--fx-rot": deg(rand(240, 620)),
        },
      };
    },
  },

  // 雪: 白い粒がゆっくり左右に揺れながら降る
  snow: {
    animationClassName: "animate-overlay-effect-snow",
    spawnLeftPercentRange: [0, 100],
    spawnTopPercentRange: [-8, 8],
    durationSecRange: [3.4, 6.0],
    startAtRandomPhase: true,
    particleCount: 40,
    buildParticle: () => {
      const size = rand(4, 11);
      const opacity = rand(0.6, 1);
      return {
        content: "",
        visualStyle: {
          width: px(size),
          height: px(size),
          borderRadius: "50%",
          backgroundColor: "#ffffff",
          boxShadow: "0 0 5px rgba(255,255,255,0.8)",
          "--fx-fall": px(rand(240, 360)),
          "--fx-sway": px(rand(10, 28)),
          "--fx-opacity": opacity.toFixed(2),
        },
      };
    },
  },

  // コイン: 金貨が回転（横フリップ）しながら落ちてくる（大当たり演出向け）
  coins: {
    animationClassName: "animate-overlay-effect-coins",
    spawnLeftPercentRange: [0, 100],
    spawnTopPercentRange: [-8, 6],
    durationSecRange: [1.8, 3.0],
    startAtRandomPhase: true,
    particleCount: 22,
    buildParticle: () => {
      const size = rand(12, 22);
      const color = pick(COIN_COLORS);
      return {
        content: "",
        visualStyle: {
          width: px(size),
          height: px(size),
          borderRadius: "50%",
          // ふちを明るく、中心をやや暗くした金貨風の陰影
          backgroundImage: `radial-gradient(circle at 38% 32%, #fffbe6, ${color} 55%, #b45309 100%)`,
          boxShadow: `0 0 4px ${color}, inset 0 0 2px rgba(180,83,9,0.6)`,
          "--fx-fall": px(rand(240, 360)),
          "--fx-spin": deg(rand(720, 1440)),
        },
      };
    },
  },

  // 縁の炎: カードの縁に沿って多数の小さな炎粒子を配置し、上方向へ揺らぎ
  // ながら昇って消える演出（Issue #2088 (3)）。従来はカード内側に重なる
  // 76/86/96% の円形リング3層だったが、「枠の外に炎が見える」見た目へ変える
  // ため overlay page 側でカード背面（DOM 順でカードより前）の `inset:0`
  // レイヤーに描画する。ここで生成する left/top の % はそのレイヤー箱＝
  // カード枠と一致する（通常表示はカード容器、imageOnly は画像を含む
  // 表示列）前提の座標系。
  //
  // 粒子の色は枠のレアリティ色に合わせる。色自体は生成時に決めず
  // `var(--fx-aura-from)` / `var(--fx-aura-to)` を参照し、レイヤー側が
  // resolveOverlayAuraColors で解決した枠グラデーション色を CSS 変数として
  // 当てる（カスタムレアリティの HEX もそのまま炎色になる）。
  aura: {
    animationClassName: "animate-overlay-effect-aura",
    // 位置は buildParticle が縁上へ直接指定する。範囲そのものは使われないが
    // 契約上 [0,100] の % 座標に収めるため目安として保持する。
    spawnLeftPercentRange: [0, 100],
    spawnTopPercentRange: [0, 100],
    durationSecRange: [0.9, 1.7],
    // 負の delay で表示開始時点から炎が燃え続けている位相にする（環境系と同じ
    // 意図だが、位相範囲を遅延範囲として直に宣言する従来どおりの形式を維持）。
    delaySecRange: [-1.4, 0],
    // 周囲4辺に12個ずつ。320px の縁でおよそ26〜27px間隔の炎になる密度。
    particleCount: 48,
    buildParticle: (index) => {
      // index%4 で4辺へ順に割り当て、辺上の位置は等間隔＋ジッターで散らす
      // （等間隔だけだと数直線的に並んで見え、完全乱数だと疎密が出るため）。
      const particlesPerEdge = 12;
      const edge = index % 4;
      const slot = Math.floor(index / 4);
      const along = ((slot + rand(0.15, 0.85)) / particlesPerEdge) * 100;
      // 炎の中心を縁から 0〜1.5% 内側へずらし、基部が枠の裏に食い込んで
      // 「枠の後ろから炎が出ている」ように見せる。背面レイヤーなので
      // 粒子の内側半分はカードに隠れ、外側半分だけが見える。
      const edgeInset = rand(0, 1.5);
      const left = edge === 1 ? 100 - edgeInset : edge === 3 ? edgeInset : along;
      const top = edge === 2 ? 100 - edgeInset : edge === 0 ? edgeInset : along;

      // 幅に対して縦長の揺らぐ粒。径は燃え立つ炎らしさと密度のバランスから。
      const width = rand(5, 11);
      const height = width * rand(1.4, 2.2);
      // 交互に from/to を主色にして枠グラデーションの両端の色を炎に混ぜる。
      // コアは白熱（白）→ 縁色 → 透明 の順で、どのレアリティ色でも炎らしい
      // 中心の明るさが出る構成。
      const mid = index % 2 === 0 ? "var(--fx-aura-from)" : "var(--fx-aura-to)";
      const outer = index % 2 === 0 ? "var(--fx-aura-to)" : "var(--fx-aura-from)";
      return {
        content: "",
        left: `${left.toFixed(2)}%`,
        top: `${top.toFixed(2)}%`,
        visualStyle: {
          width: px(width),
          height: px(height),
          // 上端を細くした雫形（炎のシルエット）
          borderRadius: "50% 50% 50% 50% / 68% 68% 32% 32%",
          backgroundImage: `radial-gradient(ellipse at 50% 80%, rgba(255,255,255,0.9) 0%, ${mid} 42%, ${outer} 68%, transparent 82%)`,
          boxShadow: `0 0 ${px(width)} ${mid}`,
          "--fx-rise": px(rand(28, 56)),
          "--fx-sway": px(rand(3, 9)),
          "--fx-peak": rand(0.7, 1).toFixed(2),
        },
      };
    },
  },
} as const;

/* -------------------------------------------------------------------------- */
/* aura（縁の炎）の色解決                                                       */
/* -------------------------------------------------------------------------- */

/**
 * aura の炎粒子が参照する CSS 変数名。粒子の backgroundImage/boxShadow は
 * この2変数を `var(...)` で参照し、実色は overlay page が aura レイヤー
 * 要素へ inline style で当てる（粒子生成層は描画コンテキストを知らないため
 * 「色は呼び出し側が注入する」分離にする）。
 */
export const OVERLAY_AURA_COLOR_VARS = {
  from: "--fx-aura-from",
  to: "--fx-aura-to",
} as const;

/**
 * 色解決に失敗したときのフォールバック（炎らしい琥珀→橙）。
 * 通常経路では枠グラデーションが常に解決できるため、クラス形式・変数欠落など
 * 想定外の入力に対する安全側の値。
 */
const OVERLAY_AURA_FALLBACK_COLORS = ["#fbbf24", "#f97316"] as const;

/**
 * aura（縁の炎）の炎色を、カード枠と同じレアリティのグラデーション色から
 * 解決する（Issue #2088 (3): 「粒子の色は枠のレアリティ色に合わせる」）。
 *
 * 解決順:
 * 1. カスタムレアリティ色: getRarityStylePresentation が styleVars に展開した
 *    `--rarity-gradient-from` / `--rarity-gradient-to` の HEX をそのまま使う。
 * 2. ビルトイン/未設定: `from-{hue}-{shade} to-{hue}-{shade}` 形式の
 *    グラデーションクラスを TAILWIND_PALETTE_HEX で HEX へ引く
 *    （rarity-styles.ts の legacy 形式正規化と同じ対応表）。
 * 3. どちらも解決できない異常入力はフォールバック色に倒す。
 *
 * 返り値は [from, to]。overlay page は aura レイヤーへ
 * `--fx-aura-from` / `--fx-aura-to` として当てる。
 */
export function resolveOverlayAuraColors(
  gradientClass: string,
  styleVars: Record<string, unknown> | null | undefined,
): readonly [string, string] {
  const customFrom = styleVars?.[RARITY_STYLE_CSS_VARS.gradientFrom];
  const customTo = styleVars?.[RARITY_STYLE_CSS_VARS.gradientTo];
  if (
    typeof customFrom === "string" && customFrom !== ""
    && typeof customTo === "string" && customTo !== ""
  ) {
    return [customFrom, customTo];
  }

  const preset = /^from-([a-z]+-[0-9]{2,3})\s+to-([a-z]+-[0-9]{2,3})$/.exec(
    gradientClass.trim(),
  );
  if (preset) {
    const from = TAILWIND_PALETTE_HEX[preset[1]];
    const to = TAILWIND_PALETTE_HEX[preset[2]];
    if (from && to) {
      return [from, to];
    }
  }
  return [OVERLAY_AURA_FALLBACK_COLORS[0], OVERLAY_AURA_FALLBACK_COLORS[1]];
}

export interface OverlayEffectParticle extends OverlayEffectParticlePresentation {
  left: string;
  top: string;
  animationDelay: string;
  animationDuration: string;
}

function randomInRange([min, max]: readonly [number, number]): number {
  return min + Math.random() * (max - min);
}

/**
 * 秒数を CSS の time 値へ整形する。`-0.00s` のような負のゼロは有効な CSS だが
 * DOM 上で紛らわしいため 0 に丸める。
 */
function formatSeconds(value: number): string {
  const normalized = Math.abs(value) < 0.005 ? 0 : value;
  return `${normalized.toFixed(2)}s`;
}

/**
 * 1粒子の開始遅延（秒）を決める。
 *
 * - startAtRandomPhase のスタイル: `-[0, duration]` の負の delay を返す。負の delay は
 *   「あたかも duration のうち [0, |delay|) の時間が既に経過した状態」から開始する
 *   指定なので、fill-mode: none でも表示開始の最初のフレームからアニメーションが
 *   適用される。これが「遅延中は不透明なまま静止する」現象を無くす手段。
 * - それ以外: 宣言された delaySecRange から正の delay を選ぶ（fireworks の
 *   バースト間隔、aura の位相ずらし）。範囲が無い場合は即時開始（0）に倒す。
 */
function resolveDelaySec(
  config: OverlayEffectParticleConfig,
  durationSec: number,
): number {
  if (config.startAtRandomPhase) {
    return -randomInRange([0, durationSec]);
  }
  return config.delaySecRange ? randomInRange(config.delaySecRange) : 0;
}

/**
 * 指定スタイルのパーティクル（出現位置・タイミング・見た目）を生成する。
 * 個数は各スタイルの particleCount。"none" や未知スタイルは空配列。
 *
 * left/top はスタイルごとの出現エリアから、色・サイズ・軌道パラメータ（CSS変数）は
 * buildParticle が個別化することで、同一演出内でもパーティクルが機械的に同期しない
 * 自然な見た目にする。duration は「先に」確定してから delay を決める（負の delay の
 * 絶対値が 1 周期を超えると 2 周目に入り、開始位相の意図が崩れるため）。
 */
export function generateOverlayEffectParticles(
  style: OverlayEffectStyle,
): OverlayEffectParticle[] {
  if (style === "none") return [];
  const config = OVERLAY_EFFECT_PARTICLE_CONFIG[style];
  if (!config) return [];
  return Array.from({ length: config.particleCount }, (_, index) => {
    const presentation = config.buildParticle(index);
    const durationSec = presentation.durationSec ?? randomInRange(config.durationSecRange);
    const delaySec = presentation.delaySec ?? resolveDelaySec(config, durationSec);
    return {
      // presentation が left/top/delaySec/durationSec を上書きしていればそれを使う
      // （fireworks の共通バースト中心・同時破裂など、位置とタイミングの協調が必要な演出用）。
      left: presentation.left ?? `${randomInRange(config.spawnLeftPercentRange).toFixed(2)}%`,
      top: presentation.top ?? `${randomInRange(config.spawnTopPercentRange).toFixed(2)}%`,
      animationDelay: formatSeconds(delaySec),
      animationDuration: formatSeconds(durationSec),
      content: presentation.content,
      visualStyle: presentation.visualStyle,
    };
  });
}
