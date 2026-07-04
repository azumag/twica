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
  | "coins";

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
 * DEFAULT_BUILTIN_RARITY_EFFECTS のうち "none" でないものだけを持つ
 * （= legendary: sparkle）。resolveEffectForRarity は未登録レアリティを
 * "none" とみなすため、これで「legendary のみ sparkle」を表現できる。
 */
export const DEFAULT_RARITY_EFFECT_MAP: RarityEffectMap = { legendary: "sparkle" };

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
 * 例: { epic:"confetti", legendary:"fireworks" } → "epic:confetti,legendary:fireworks"
 */
export function serializeRarityEffectMap(map: RarityEffectMap): string {
  const pairs = Object.entries(map)
    .filter(([, style]) => style !== "none" && isOverlayEffectStyle(style))
    .map(([rarity, style]) => `${rarity}:${style}`);
  return pairs.length > 0 ? pairs.join(",") : RARITY_EFFECT_MAP_OFF_SENTINEL;
}

/** レアリティ名の最大長。constants.MAX_RARITY_KEY_LENGTH と整合（循環 import を避けるため即値）。 */
const MAX_RARITY_KEY_LENGTH_FOR_FX = 40;
/** 攻撃的な入力でマップが肥大化しないための上限（ビルトイン4種＋カスタム分の余裕）。 */
const MAX_RARITY_EFFECT_ENTRIES = 60;

/**
 * `fx=` の値をレアリティ別マップにデコードする。
 * "off"／空文字は「全レアリティ演出なし」（空マップ）。
 * 不正なペア（レアリティ名が長すぎる/空、未知スタイル）はスキップする
 * （未知スタイルを sparkle 等に丸めると誤爆するため、その項目自体を無視する）。
 */
function deserializeRarityEffectMap(fxValue: string): RarityEffectMap {
  // split 前に入力長を制限しておく（防御的: 極端に長い値の split を避ける。
  // 実用上は「レアリティ名:スタイル」× 数十件で十分収まる長さ）。
  const trimmed = fxValue.trim().slice(0, MAX_RARITY_EFFECT_ENTRIES * (MAX_RARITY_KEY_LENGTH_FOR_FX + 16));
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
    const rarity = pair.slice(0, separatorIndex).trim();
    const style = pair.slice(separatorIndex + 1).trim();
    if (rarity.length === 0 || rarity.length > MAX_RARITY_KEY_LENGTH_FOR_FX) continue;
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
  animationDelay?: string;
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
  /** 開始遅延秒数の範囲 [min, max] */
  delaySecRange: readonly [number, number];
  /** このスタイルの既定パーティクル数（花火/雪など密度が要るものは多めにする） */
  particleCount: number;
  /** index からこのパーティクル固有の見た目（色・サイズ・軌道パラメータ）を生成する */
  buildParticle: (index: number) => OverlayEffectParticlePresentation;
}

/* ---- 生成ヘルパ（自然なばらつきのための乱数ユーティリティ） ---- */
function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
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
 * スタイルごとの設定。animationClassName は globals.css の @theme inline で
 * 定義した animate-* ユーティリティ名（キーフレーム overlay-effect-<style>）。
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
    delaySecRange: [0, 2],
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
    delaySecRange: [0, 2.4],
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
    delaySecRange: [0, 2.4],
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
  // 各パーティクルは1個の火花で、同じバーストに属する火花は出現位置と開始タイミングを
  // 共有する（buildParticle が left/top/animationDelay を上書きする）。これにより
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
      // バーストの中心（%）。spawnLeft [20,80] / spawnTop [12,48] の内側に置く。
      const burstCenters: readonly [number, number][] = [
        [34, 24],
        [66, 30],
        [50, 20],
        [46, 42],
      ];
      const sparksPerBurst = 12;
      const burst = burstCenters[Math.floor(index / sparksPerBurst) % burstCenters.length];

      const size = rand(3, 6);
      const color = pick(FIREWORK_COLORS);
      // 放射方向をランダムな角度・距離で決め、--fx-dx/--fx-dy に格納する
      const angle = rand(0, Math.PI * 2);
      const radius = rand(60, 150);
      return {
        content: "",
        // 同じバーストの火花は同一中心（±微ジッター）から、ほぼ同時に破裂する
        left: `${(burst[0] + rand(-2, 2)).toFixed(2)}%`,
        top: `${(burst[1] + rand(-2, 2)).toFixed(2)}%`,
        animationDelay: `${((Math.floor(index / sparksPerBurst) % burstCenters.length) * 0.55 + rand(0, 0.25)).toFixed(2)}s`,
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

  // 流れ星: 尾を引く光の筋が斜めに横切る
  stars: {
    animationClassName: "animate-overlay-effect-stars",
    spawnLeftPercentRange: [-5, 70],
    spawnTopPercentRange: [0, 55],
    durationSecRange: [1.3, 2.3],
    delaySecRange: [0, 2.8],
    particleCount: 16,
    buildParticle: () => {
      const length = rand(50, 110);
      const color = pick(STAR_COLORS);
      // 進行方向（右下がり）へ移動。角度から見た目の回転も一致させる
      const dx = rand(160, 300);
      const dy = rand(90, 200);
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
    delaySecRange: [0, 2.6],
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
    delaySecRange: [0, 2.8],
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
    delaySecRange: [0, 3.0],
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
    delaySecRange: [0, 2.4],
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
} as const;

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
 * 指定スタイルのパーティクル（出現位置・タイミング・見た目）を生成する。
 * 個数は各スタイルの particleCount。"none" や未知スタイルは空配列。
 *
 * left/top はスタイルごとの出現エリアから、delay/duration も範囲からランダムに決め、
 * さらに buildParticle で色・サイズ・軌道パラメータ（CSS変数）を個別化することで、
 * 同一演出内でもパーティクルが機械的に同期しない自然な見た目にする。
 */
export function generateOverlayEffectParticles(
  style: OverlayEffectStyle,
): OverlayEffectParticle[] {
  if (style === "none") return [];
  const config = OVERLAY_EFFECT_PARTICLE_CONFIG[style];
  if (!config) return [];
  return Array.from({ length: config.particleCount }, (_, index) => {
    const presentation = config.buildParticle(index);
    return {
      // presentation が left/top/animationDelay を上書きしていればそれを使う
      // （fireworks の共通バースト中心など、位置・タイミングの協調が必要な演出用）。
      left: presentation.left ?? `${randomInRange(config.spawnLeftPercentRange).toFixed(2)}%`,
      top: presentation.top ?? `${randomInRange(config.spawnTopPercentRange).toFixed(2)}%`,
      animationDelay: presentation.animationDelay ?? `${randomInRange(config.delaySecRange).toFixed(2)}s`,
      animationDuration: `${randomInRange(config.durationSecRange).toFixed(2)}s`,
      content: presentation.content,
      visualStyle: presentation.visualStyle,
    };
  });
}
