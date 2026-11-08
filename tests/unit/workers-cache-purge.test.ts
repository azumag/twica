import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/logger", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { purgeCacheTagsBestEffort } from "@/lib/workers-cache-purge";
import { logger } from "@/lib/logger";

describe("purgeCacheTagsBestEffort (#1334)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("no-ops on an empty tag list without touching the runtime module", async () => {
    await expect(purgeCacheTagsBestEffort([])).resolves.toBeUndefined();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("does not throw when cloudflare:workers is unavailable (Node/test), and logs a warning", async () => {
    // Workers 固有モジュールは Node/vitest では解決できない。best-effort なので
    // 例外を投げず、保存処理を失敗させないことだけを固定する。
    await expect(
      purgeCacheTagsBestEffort(["sound-settings-123e4567-e89b-42d3-a456-426614174000"])
    ).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      "workers-cache-purge: purge skipped/failed",
      expect.objectContaining({ tags: ["sound-settings-123e4567-e89b-42d3-a456-426614174000"] })
    );
  });
});
