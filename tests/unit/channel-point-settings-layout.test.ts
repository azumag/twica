import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function readSource(path: string) {
  return readFileSync(join(process.cwd(), path), "utf8");
}

describe("ChannelPointSettings layout", () => {
  it("keeps the additional reward selector and add button inside the settings panel", () => {
    const source = readSource("src/components/ChannelPointSettings.tsx");

    expect(source).toContain("grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center");
    expect(source).toContain("w-full min-w-0 rounded-lg bg-gray-600 px-3 py-2 text-sm text-gray-200");
    expect(source).toContain("w-full rounded-lg bg-purple-600 px-4 py-2 text-sm text-white hover:bg-purple-700 disabled:opacity-50 sm:w-auto");
  });
});
