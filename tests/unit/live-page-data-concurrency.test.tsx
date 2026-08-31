import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  canUseStreamerFeatures: vi.fn(),
  getLiveDirectory: vi.fn(),
  getLiveDirectoryPresence: vi.fn(),
  getLiveDirectoryRankings: vi.fn(),
  getTranslations: vi.fn(),
  getUnreadAnnouncements: vi.fn(),
  getUserPlanSnapshot: vi.fn(),
}));

vi.mock("@/lib/session", () => ({
  getSession: mocks.getSession,
  canUseStreamerFeatures: mocks.canUseStreamerFeatures,
}));
vi.mock("@/lib/live-directory", () => ({
  getLiveDirectory: mocks.getLiveDirectory,
  getLiveDirectoryPresence: mocks.getLiveDirectoryPresence,
  getLiveDirectoryRankings: mocks.getLiveDirectoryRankings,
}));
vi.mock("@/lib/announcements", () => ({
  getUnreadAnnouncements: mocks.getUnreadAnnouncements,
}));
vi.mock("@/lib/plan", () => ({
  getUserPlanSnapshot: mocks.getUserPlanSnapshot,
}));
vi.mock("next-intl/server", () => ({
  getTranslations: mocks.getTranslations,
}));
vi.mock("@/components/LiveDirectory", () => ({ default: () => null }));
vi.mock("@/components/Header", () => ({ default: () => null }));
vi.mock("@/components/DashboardNav", () => ({ default: () => null }));
vi.mock("@/components/PublicFooter", () => ({ default: () => null }));

import LivePage from "@/app/live/page";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe("LivePage data concurrency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSession.mockResolvedValue({ twitchUserId: "user-1" });
    mocks.canUseStreamerFeatures.mockReturnValue(false);
    mocks.getLiveDirectoryPresence.mockResolvedValue(null);
    mocks.getLiveDirectoryRankings.mockResolvedValue({ last7Days: [], allTime: [] });
    mocks.getTranslations.mockResolvedValue((key: string) => key);
    mocks.getUnreadAnnouncements.mockResolvedValue([]);
    mocks.getUserPlanSnapshot.mockResolvedValue("basic");
  });

  it("starts authenticated header queries before a slow directory request finishes", async () => {
    const directory = deferred<unknown[]>();
    mocks.getLiveDirectory.mockReturnValue(directory.promise);

    const pagePromise = LivePage();

    // getSession() の解決だけを進め、directory promise は未解決のまま維持する。
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.getUserPlanSnapshot).toHaveBeenCalledWith("user-1");
    expect(mocks.getUnreadAnnouncements).toHaveBeenCalledWith("user-1");

    directory.resolve([]);
    await expect(pagePromise).resolves.toBeDefined();
  });
});
