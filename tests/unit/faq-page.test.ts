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

  it("renders the shared public footer on every public page", () => {
    const pages = [
      "src/app/page.tsx",
      "src/app/guide/page.tsx",
      "src/app/about/page.tsx",
      "src/app/privacy/page.tsx",
      "src/app/tos/page.tsx",
      "src/app/releases/page.tsx",
      "src/app/plans/page.tsx",
      "src/app/faq/page.tsx",
    ];

    for (const page of pages) {
      const source = readSource(page);

      expect(source).toContain('import PublicFooter from "@/components/PublicFooter"');
      expect(source).toContain("<PublicFooter />");
      expect(source).not.toContain('getTranslations("footer")');
    }
  });

  it("keeps the public footer link set in one place", () => {
    const source = readSource("src/components/PublicFooter.tsx");

    expect(source).toContain("PUBLIC_FOOTER_LINKS");
    expect(source).toContain('href: "/guide"');
    expect(source).toContain('href: "/faq"');
    expect(source).toContain('href: "/tos"');
    expect(source).toContain('href: "/about"');
    expect(source).toContain('href: "/privacy"');
    expect(source).toContain('href: "/releases"');
  });
});
