import type { AnchorHTMLAttributes, ImgHTMLAttributes, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import Header from "@/components/Header";
import { canUseStreamerFeatures } from "@/lib/session";

vi.mock("next-intl/server", () => ({
  getTranslations: vi.fn(async () => (key: string) => `header.${key}`),
}));

vi.mock("@/lib/session", () => ({
  getSession: vi.fn(),
  canUseStreamerFeatures: vi.fn(),
}));

vi.mock("next/link", () => ({
  default: ({ children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a {...props}>{children}</a>
  ),
}));

vi.mock("next/image", () => ({
  default: ({ unoptimized, ...props }: ImgHTMLAttributes<HTMLImageElement> & { unoptimized?: boolean }) => {
    void unoptimized;
    return <img {...props} />;
  },
}));

vi.mock("@/components/LogoutButton", () => ({
  LogoutButton: ({
    children,
    label,
    className,
  }: {
    children: ReactNode;
    label: string;
    className?: string;
  }) => (
    <button type="button" aria-label={label} className={className}>
      {children}
    </button>
  ),
}));

describe("Header rendering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(canUseStreamerFeatures).mockReturnValue(true);
  });

  it("returns null when there is no session", async () => {
    await expect(Header({ session: null })).resolves.toBeNull();
  });

  it("renders the signed-in navigation without relying on source/parent structure", async () => {
    const element = await Header({
      session: {
        twitchDisplayName: "Viewer 😀",
        twitchProfileImageUrl: "https://example.com/avatar.png",
        broadcasterType: "",
      } as never,
      unreadAnnouncementsCount: 120,
    });

    const html = renderToStaticMarkup(element);

    expect(html).toContain('href="/"');
    expect(html).toContain('src="https://example.com/avatar.png"');
    expect(html).toContain('alt=""');
    expect(html.match(/Viewer 😀/g)).toHaveLength(2);
    expect(html).toContain("header.streamerBadge");
    expect(html).toContain('href="/dashboard/announcements"');
    expect(html).toContain("99+");
    expect(html).toContain('href="/dashboard/account"');
    expect(html).toContain('aria-label="header.logout"');
  });
});
