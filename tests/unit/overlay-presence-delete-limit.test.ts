import { describe, expect, it, vi } from "vitest";
import { OverlayPresence } from "../../workers/overlay-realtime/src/index";

describe("OverlayPresence expired lease cleanup", () => {
  it("never sends more than 128 keys to Durable Object storage.delete", async () => {
    const records = new Map<string, unknown>(
      Array.from({ length: 129 }, (_, index) => [
        `room:streamer-${String(index).padStart(3, "0")}`,
        { lastSeen: 0 },
      ]),
    );

    const deleteMock = vi.fn(async (keyOrKeys: string | string[]) => {
      const keys = Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys];
      if (keys.length > 128) {
        throw new Error(`storage.delete batch exceeded 128 keys: ${keys.length}`);
      }
      for (const key of keys) records.delete(key);
    });

    const storage = {
      get: vi.fn(async (key: string) => records.get(key)),
      put: vi.fn(async (key: string, value: unknown) => {
        records.set(key, value);
      }),
      delete: deleteMock,
      list: vi.fn(async ({
        prefix,
        limit,
        startAfter,
      }: {
        prefix?: string;
        limit?: number;
        startAfter?: string;
      }) => {
        const entries = [...records.entries()]
          .filter(([key]) => !prefix || key.startsWith(prefix))
          .filter(([key]) => !startAfter || key > startAfter)
          .sort(([left], [right]) => left.localeCompare(right))
          .slice(0, limit);
        return new Map(entries);
      }),
      getAlarm: vi.fn().mockResolvedValue(null),
      setAlarm: vi.fn().mockResolvedValue(undefined),
      deleteAlarm: vi.fn().mockResolvedValue(undefined),
    };
    const state = { storage };
    const presence = new OverlayPresence(state as never, {} as never);

    const response = await presence.fetch(
      new Request("https://presence.internal/snapshot"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ count: 0 });
    const deleteBatches = deleteMock.mock.calls
      .map(([keys]) => keys)
      .filter(Array.isArray);
    expect(deleteBatches).toHaveLength(2);
    expect(deleteBatches.map((keys) => keys.length)).toEqual([128, 1]);
    expect([...records.keys()].filter((key) => key.startsWith("room:"))).toEqual([]);
  });
});
