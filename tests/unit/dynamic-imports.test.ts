import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function readSource(path: string) {
  return readFileSync(join(process.cwd(), path), "utf8");
}

describe("dashboard dynamic imports", () => {
  it("lazy-loads the large card manager client component", () => {
    const source = readSource("src/app/dashboard/cards/page.tsx");

    expect(source).toContain('import dynamic from "next/dynamic"');
    expect(source).toContain('dynamic(() => import("@/components/CardManager")');
    expect(source).not.toContain('import CardManager from "@/components/CardManager"');
  });

  it("lazy-loads the gacha history table client component", () => {
    const source = readSource("src/app/dashboard/history/page.tsx");

    expect(source).toContain('import dynamic from "next/dynamic"');
    expect(source).toContain('dynamic(() => import("@/components/GachaHistoryTable")');
    expect(source).not.toContain('import GachaHistoryTable from "@/components/GachaHistoryTable"');
  });

  it("lazy-loads streamer settings panels", () => {
    const source = readSource("src/app/dashboard/settings/page.tsx");

    expect(source).toContain('dynamic(() => import("@/components/OverlayPreview")');
    expect(source).toContain('dynamic(() => import("@/components/ChannelPointSettings")');
    expect(source).toContain('dynamic(() => import("@/components/GachaSoundSettings")');
    expect(source).toContain('dynamic(() => import("@/components/ChatAnnouncementSettings")');
    expect(source).toContain('dynamic(() => import("@/components/CardVisibilitySettings")');
  });
});
