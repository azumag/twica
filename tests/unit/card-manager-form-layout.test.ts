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
    expect(source).toContain('list="card-rarity-options"');
    expect(source).toContain("w-full min-w-0 rounded-lg bg-gray-600 px-4 py-2 text-white");
    expect(source).toContain("w-full min-w-0 rounded-lg bg-gray-600");
  });
});
