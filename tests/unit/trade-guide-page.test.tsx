import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";

/**
 * /guide/trade renders from the real ja/en message catalogs.
 *
 * getTranslations is mocked with a resolver over the actual messages/*.json that THROWS
 * on a missing key. next-intl itself would only log the error and print the key path,
 * so a key missing from one locale would otherwise show up as a raw "tradeGuidePage.x.y"
 * string in production without failing any test.
 */
const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  locale: { current: "ja" as "ja" | "en" },
}));

vi.mock("@/lib/session", () => ({ getSession: mocks.getSession }));
vi.mock("@/components/PublicFooter", () => ({ default: () => <footer data-testid="public-footer" /> }));
vi.mock("next-intl/server", async () => {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const catalogs = {
    ja: JSON.parse(readFileSync(join(process.cwd(), "messages/ja.json"), "utf8")),
    en: JSON.parse(readFileSync(join(process.cwd(), "messages/en.json"), "utf8")),
  } as Record<string, Record<string, unknown>>;
  return {
    getTranslations: async (namespace: string) => (key: string) => {
      let value: unknown = catalogs[mocks.locale.current];
      for (const part of `${namespace}.${key}`.split(".")) {
        value = (value as Record<string, unknown> | undefined)?.[part];
      }
      if (typeof value !== "string") {
        throw new Error(`MISSING_MESSAGE(${mocks.locale.current}): ${namespace}.${key}`);
      }
      return value;
    },
  };
});

import TradeGuidePage, { metadata } from "@/app/guide/trade/page";

function readMessages(locale: "ja" | "en") {
  return JSON.parse(readFileSync(join(process.cwd(), `messages/${locale}.json`), "utf8"));
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.locale.current = "ja";
  mocks.getSession.mockResolvedValue(null);
});

describe.each(["ja", "en"] as const)("/guide/trade (%s)", (locale) => {
  beforeEach(() => {
    mocks.locale.current = locale;
  });

  it("renders for anonymous visitors with the title, every section and the footer", async () => {
    const page = readMessages(locale).tradeGuidePage;
    render(await TradeGuidePage());

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(page.title);
    for (const id of ["overview", "offer", "auction", "streamer", "faq"] as const) {
      const heading = screen.getByRole("heading", { level: 2, name: page[id].title });
      expect(heading.closest("section")).toHaveAttribute("id", id);
    }
    expect(screen.getByTestId("public-footer")).toBeInTheDocument();
    // 未ログインでも閲覧でき、ホームへ戻れる（/guide と同じヘッダー）
    expect(screen.getByRole("link", { name: readMessages(locale).guidePage.home })).toHaveAttribute("href", "/");
  });

  it("renders every step title/description, substep, point and FAQ entry from the catalog", async () => {
    const page = readMessages(locale).tradeGuidePage;
    const { container } = render(await TradeGuidePage());
    const text = container.textContent ?? "";

    for (const scope of ["overview", "offer", "auction", "streamer"] as const) {
      const section = container.querySelector(`section#${scope}`)!;
      for (const [step, body] of Object.entries(page[scope])) {
        if (typeof body === "string") continue; // title / lead / requirement
        const card = body as Record<string, string>;
        expect(section.textContent, `${scope}.${step}`).toContain(card.title);
        expect(section.textContent, `${scope}.${step}`).toContain(card.description);
        for (const [key, value] of Object.entries(card)) {
          if (key.startsWith("substep") || key.startsWith("point")) {
            expect(section.textContent, `${scope}.${step}.${key}`).toContain(value);
          }
        }
      }
    }
    for (const [item, body] of Object.entries(page.faq)) {
      if (item === "title") continue;
      const qa = body as { question: string; answer: string };
      expect(text, `faq.${item}`).toContain(qa.question);
      expect(text, `faq.${item}`).toContain(qa.answer);
    }
    // キーパスがそのまま画面に出ていない
    expect(text).not.toContain("tradeGuidePage.");
  });

  it("numbers step cards from the array order and renders sequences as real lists", async () => {
    const { container } = render(await TradeGuidePage());
    const offer = container.querySelector("section#offer")!;
    const badges = [...offer.querySelectorAll("span.rounded-full")].map((el) => el.textContent);
    expect(badges).toEqual(["1", "2", "3", "4", "5", "6"]);

    // 出品の手順は <ol>（4手順）、ルール列挙は <ul>
    const create = within(offer as HTMLElement).getAllByRole("list")[0];
    expect(create.tagName).toBe("OL");
    expect(create.querySelectorAll("li")).toHaveLength(4);
    expect(container.querySelector("section#auction ul")).not.toBeNull();
  });

  it("links the table of contents to the section anchors", async () => {
    const { container } = render(await TradeGuidePage());
    const hrefs = [...container.querySelectorAll('nav[aria-label] a[href^="#"]')].map((a) =>
      a.getAttribute("href"),
    );
    expect(hrefs).toEqual(["#overview", "#offer", "#auction", "#streamer", "#faq"]);
    for (const href of hrefs) {
      expect(container.querySelector(href!)).not.toBeNull();
    }
  });
});

describe("/guide/trade header", () => {
  it("shows the dashboard button for logged-in users instead of the home link", async () => {
    mocks.getSession.mockResolvedValue({ twitchUserId: "viewer-1" });
    render(await TradeGuidePage());
    expect(screen.getByRole("link", { name: readMessages("ja").header.dashboard })).toHaveAttribute(
      "href",
      "/dashboard",
    );
    expect(screen.queryByRole("link", { name: readMessages("ja").guidePage.home })).toBeNull();
  });

  it("exports static English metadata like the other public help pages", () => {
    expect(metadata.title).toBe("Card Trading Guide - TwiCa");
    expect(metadata.description).toBeTruthy();
  });
});
