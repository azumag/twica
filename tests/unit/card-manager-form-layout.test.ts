import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function readSource(path: string) {
  return readFileSync(join(process.cwd(), path), "utf8");
}

describe("CardManager form layout", () => {
  it("keeps the two-pane card form from overflowing narrow modal columns", () => {
    const source = readSource("src/components/CardManager.tsx");

    expect(source).toContain("md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]");
    expect(source).toContain("flex min-w-0 flex-col justify-between gap-4");
    expect(source).toContain("grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]");
    expect(source).toContain("w-full min-w-0 rounded-lg bg-gray-600 px-4 py-2 text-white");

    // レアリティ欄は <input list> + <datalist> ではなく
    // 全選択肢を常に表示できる <select> であること
    expect(source).not.toContain('list="card-rarity-options"');
    expect(source).not.toContain('id="card-rarity-options"');
    expect(source).toContain('<select\n                          name="rarity"');
    expect(source).toContain(
      "w-full min-w-0 appearance-none rounded-lg bg-gray-600 px-4 py-2 pr-8 text-white",
    );
    expect(source).toContain("style={SELECT_ARROW_STYLE}");
    // 選択肢は rarityOptions から動的に生成されていること
    expect(source).toContain("{rarityOptions.map((rarity) => (");
    expect(source).toContain(
      "<option key={rarity} value={rarity}>",
    );
  });
});
