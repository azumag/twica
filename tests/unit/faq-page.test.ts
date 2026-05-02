import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function readSource(path: string) {
  return readFileSync(join(process.cwd(), path), "utf8");
}

describe("FAQ page", () => {
  it("adds a localized public FAQ route", () => {
    const source = readSource("src/app/faq/page.tsx");
    const jaMessages = JSON.parse(readSource("messages/ja.json"));
    const enMessages = JSON.parse(readSource("messages/en.json"));

    expect(source).toContain('getTranslations("faqPage")');
    expect(source).toContain('href="/about"');
    expect(jaMessages.faqPage.title).toBe("よくある質問");
    expect(enMessages.faqPage.title).toBe("FAQ");
  });

  it("links FAQ from the shared public footer pattern", () => {
    const pages = [
      "src/app/page.tsx",
      "src/app/guide/page.tsx",
      "src/app/about/page.tsx",
      "src/app/privacy/page.tsx",
      "src/app/tos/page.tsx",
      "src/app/releases/page.tsx",
      "src/app/plans/page.tsx",
    ];

    for (const page of pages) {
      const source = readSource(page);

      expect(source).toContain('href="/faq"');
      expect(source).toContain('tFooter("faq")');
    }
  });
});
