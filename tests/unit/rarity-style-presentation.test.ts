import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_RARITY_COLOR_CLASS,
  DEFAULT_RARITY_GLOW_CLASS,
  DEFAULT_RARITY_GRADIENT_CLASS,
  RARITY_STYLE_CSS_VARS,
  RARITY_STYLE_VAR_CLASSES,
  getRarityColorClass,
  getRarityStylePresentation,
} from "@/lib/rarity";
import type { RarityStyles } from "@/lib/rarity-styles";

// Issue #1783 フェーズ2: 保存済み rarity_styles を「クラス + CSS 変数」の1組へ
// 解決する描画ヘルパの契約。
//
// ここで固定したい性質は3つ:
//  1. 未設定時は従来（プリセット）と完全に同じ出力になる後方互換。
//  2. 受理される HEX をクラス + CSS 変数の1組として描画できること
//     （許可形式でない値はプリセットへ縮退）。
//  3. 破損・手編集された JSONB 値でも例外を出さずプリセットへ縮退すること
//     （DB の CHECK はトップレベルの object しか保証しない）。
describe("getRarityStylePresentation", () => {
  // Tailwind v4 はソース走査(JIT)なので、var() 参照クラスが「変数展開」で
  // 組み立てられていると CSS が生成されず、ビルドは成功するのに色が付かない。
  // ここでは (a) 期待する literal そのものか、(b) その literal が実際に
  // src/lib/rarity.ts に literal として存在するか、の両方を固定する。
  describe("Tailwind 走査対象としての literal 契約", () => {
    it("RARITY_STYLE_VAR_CLASSES はリテラル文字列である", () => {
      expect(RARITY_STYLE_VAR_CLASSES).toEqual({
        color: "bg-[color:var(--rarity-color)]",
        gradient:
          "from-[color:var(--rarity-gradient-from)] to-[color:var(--rarity-gradient-to)]",
        glow: "shadow-[color:var(--rarity-glow)]",
      });
    });

    it("CSS 変数名がクラス側の var() 参照と同期している", () => {
      expect(RARITY_STYLE_VAR_CLASSES.color).toContain(`var(${RARITY_STYLE_CSS_VARS.color})`);
      expect(RARITY_STYLE_VAR_CLASSES.gradient).toContain(
        `var(${RARITY_STYLE_CSS_VARS.gradientFrom})`,
      );
      expect(RARITY_STYLE_VAR_CLASSES.gradient).toContain(
        `var(${RARITY_STYLE_CSS_VARS.gradientTo})`,
      );
      expect(RARITY_STYLE_VAR_CLASSES.glow).toContain(`var(${RARITY_STYLE_CSS_VARS.glow})`);
    });

    it("var() 参照クラスがソース上に literal として存在する（変数展開の再混入防止）", () => {
      const source = readFileSync(
        path.resolve(process.cwd(), "src/lib/rarity.ts"),
        "utf8",
      );
      for (const className of Object.values(RARITY_STYLE_VAR_CLASSES)) {
        // 前後の二重引用符まで含めて探す: `${...}` 展開で組み立てると
        // この literal はソース上に存在しなくなる。
        expect(source).toContain(`"${className}"`);
      }
    });
  });

  describe("後方互換（スタイル未設定）", () => {
    it("styles が undefined / null / 非オブジェクトなら従来のプリセットを返す", () => {
      const expected = {
        colorClass: "bg-yellow-500",
        gradientClass: "from-yellow-400 to-orange-500",
        glowClass: "shadow-yellow-500/50",
        styleVars: {},
      };

      expect(getRarityStylePresentation("legendary")).toEqual(expected);
      expect(getRarityStylePresentation("legendary", null)).toEqual(expected);
      expect(getRarityStylePresentation("legendary", {} as RarityStyles)).toEqual(expected);
      // JSONB が配列になっていても落ちない
      expect(getRarityStylePresentation("legendary", [] as unknown as RarityStyles)).toEqual(
        expected,
      );
    });

    it("カスタムレアリティは共有フォールバック色のままになる", () => {
      expect(getRarityStylePresentation("mythic")).toEqual({
        colorClass: DEFAULT_RARITY_COLOR_CLASS,
        gradientClass: DEFAULT_RARITY_GRADIENT_CLASS,
        glowClass: DEFAULT_RARITY_GLOW_CLASS,
        styleVars: {},
      });
    });

    it("他レアリティにだけ設定があっても影響を受けない", () => {
      const styles: RarityStyles = { mythic: { color: "#ff0000" } };
      expect(getRarityStylePresentation("legendary", styles).colorClass).toBe("bg-yellow-500");
    });
  });

  describe("legacy プリセット形式の正規化（互換）", () => {
    it("フェーズ1 が保存した Tailwind クラス形式を HEX へ正規化して描画する", () => {
      // フェーズ1 の API はクラス形式も受理していた。Tailwind はソース走査でしか
      // クラスを生成しないため DB 由来のクラスは CSS に存在し得ず、そのままでは
      // 無色になる。描画時に HEX へ正規化して色を保つ（Issue #1783 互換対応）。
      const styles = {
        mythic: {
          color: "bg-red-500",
          gradient: "from-red-500 to-blue-600",
          glow: "shadow-purple-500/50",
        },
      } as unknown as RarityStyles;

      expect(getRarityStylePresentation("mythic", styles)).toEqual({
        colorClass: RARITY_STYLE_VAR_CLASSES.color,
        gradientClass: RARITY_STYLE_VAR_CLASSES.gradient,
        glowClass: RARITY_STYLE_VAR_CLASSES.glow,
        styleVars: {
          [RARITY_STYLE_CSS_VARS.color]: "#fb2c36",
          [RARITY_STYLE_CSS_VARS.gradientFrom]: "#fb2c36",
          [RARITY_STYLE_CSS_VARS.gradientTo]: "#155dfc",
          [RARITY_STYLE_CSS_VARS.glow]: "#ad46ff80",
        },
      });
    });

    it("未知の色名・シェードは正規化せずプリセット色へ戻す", () => {
      // フェーズ1 の許可集合は 18 色 × 11 シェードのみ。slate などは対象外。
      const styles = {
        mythic: { color: "bg-slate-500" },
        other: { color: "bg-red-1000" },
      } as unknown as RarityStyles;

      expect(getRarityStylePresentation("mythic", styles).colorClass).toBe(
        DEFAULT_RARITY_COLOR_CLASS,
      );
      expect(getRarityStylePresentation("other", styles).styleVars).toEqual({});
    });
  });

  describe("HEX 形式（CSS 変数経由）", () => {
    it("color は var() 参照クラス + --rarity-color になる", () => {
      const styles: RarityStyles = { mythic: { color: "#ff0000" } };
      const presentation = getRarityStylePresentation("mythic", styles);

      expect(presentation.colorClass).toBe(RARITY_STYLE_VAR_CLASSES.color);
      expect(presentation.styleVars).toEqual({
        [RARITY_STYLE_CSS_VARS.color]: "#ff0000",
      });
      // 未設定のグラデーション/グローはプリセットのまま
      expect(presentation.gradientClass).toBe(DEFAULT_RARITY_GRADIENT_CLASS);
      expect(presentation.glowClass).toBe(DEFAULT_RARITY_GLOW_CLASS);
    });

    it("#RGB 短縮形も受け付ける", () => {
      const presentation = getRarityStylePresentation("mythic", {
        mythic: { color: "#f00" },
      });
      expect(presentation.styleVars).toEqual({ [RARITY_STYLE_CSS_VARS.color]: "#f00" });
    });

    it("glow は shadow-[color:var(...)] + --rarity-glow になる", () => {
      const presentation = getRarityStylePresentation("mythic", {
        mythic: { glow: "#00ff00" },
      });
      expect(presentation.glowClass).toBe(RARITY_STYLE_VAR_CLASSES.glow);
      expect(presentation.styleVars).toEqual({ [RARITY_STYLE_CSS_VARS.glow]: "#00ff00" });
    });

    it("gradient の HEX ペアは from/to の2変数へ展開する", () => {
      const presentation = getRarityStylePresentation("mythic", {
        mythic: { gradient: "#111111,#222222" },
      });
      expect(presentation.gradientClass).toBe(RARITY_STYLE_VAR_CLASSES.gradient);
      expect(presentation.styleVars).toEqual({
        [RARITY_STYLE_CSS_VARS.gradientFrom]: "#111111",
        [RARITY_STYLE_CSS_VARS.gradientTo]: "#222222",
      });
    });

    it("3つとも HEX のときは同一要素へ3変数をまとめて返す", () => {
      const presentation = getRarityStylePresentation("mythic", {
        mythic: { color: "#010203", gradient: "#040506, #070809", glow: "#0a0b0c" },
      });
      expect(presentation.styleVars).toEqual({
        [RARITY_STYLE_CSS_VARS.color]: "#010203",
        [RARITY_STYLE_CSS_VARS.gradientFrom]: "#040506",
        [RARITY_STYLE_CSS_VARS.gradientTo]: "#070809",
        [RARITY_STYLE_CSS_VARS.glow]: "#0a0b0c",
      });
    });
  });

  describe("破損・手編集された値の縮退", () => {
    it.each([
      ["null", null],
      ["配列", []],
      ["文字列", "#ff0000"],
      ["数値", 1],
    ])("エントリが %s でも例外を出さずプリセットへ縮退する", (_label, value) => {
      const presentation = getRarityStylePresentation("mythic", {
        mythic: value,
      } as unknown as RarityStyles);

      expect(presentation).toEqual({
        colorClass: DEFAULT_RARITY_COLOR_CLASS,
        gradientClass: DEFAULT_RARITY_GRADIENT_CLASS,
        glowClass: DEFAULT_RARITY_GLOW_CLASS,
        styleVars: {},
      });
    });

    it("許可形式でない値は個別に捨て、他のキーは活かす", () => {
      const presentation = getRarityStylePresentation("mythic", {
        mythic: {
          color: "url(https://evil.example/x.png)",
          glow: "#00ff00",
        },
      } as unknown as RarityStyles);

      expect(presentation.colorClass).toBe(DEFAULT_RARITY_COLOR_CLASS);
      expect(presentation.glowClass).toBe(RARITY_STYLE_VAR_CLASSES.glow);
    });

    it("非文字列のプロパティでも例外を出さない", () => {
      const presentation = getRarityStylePresentation("mythic", {
        mythic: { color: { nested: true }, gradient: 3, glow: ["#fff"] },
      } as unknown as RarityStyles);

      expect(presentation.styleVars).toEqual({});
      expect(presentation.colorClass).toBe(DEFAULT_RARITY_COLOR_CLASS);
    });

    it("__proto__ キーをレアリティ名に使ってもプロトタイプ鎖を読まない", () => {
      // JSON.parse は "__proto__" を own プロパティとして作る。
      const styles = JSON.parse('{"__proto__": {"color": "#ff0000"}}') as RarityStyles;
      const presentation = getRarityStylePresentation("__proto__", styles);

      // own プロパティなので読み出されるが、値は検証済みの HEX に限定される
      expect(presentation.styleVars).toEqual({ [RARITY_STYLE_CSS_VARS.color]: "#ff0000" });
      // styles に無いレアリティは従来どおり（Object.prototype を拾わない）
      expect(getRarityStylePresentation("constructor", {} as RarityStyles).colorClass).toBe(
        DEFAULT_RARITY_COLOR_CLASS,
      );
    });

    it.each(["constructor", "toString", "valueOf", "hasOwnProperty"])(
      "Object.prototype 由来の名前 %s でも継承プロパティを返さない",
      (rarity) => {
        // 通常のルックアップだと RARITY_COLORS["constructor"] は Object 関数を返し、
        // className に関数が入って描画が壊れる。所有プロパティ限定で参照する。
        expect(getRarityColorClass(rarity)).toBe(DEFAULT_RARITY_COLOR_CLASS);
        expect(getRarityStylePresentation(rarity).colorClass).toBe(DEFAULT_RARITY_COLOR_CLASS);
      },
    );
  });
});
