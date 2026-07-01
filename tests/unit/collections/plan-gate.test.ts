import { describe, it, expect, vi, beforeEach } from "vitest";
import { isCollectionChangeGated } from "@/lib/plan-gate";
import { getUserPlan } from "@/lib/plan";

vi.mock("@/lib/plan");

const mockGetUserPlan = vi.mocked(getUserPlan);

describe("isCollectionChangeGated (Issue #269)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("is not gated and never calls getUserPlan when newValue is undefined (field omitted)", async () => {
    const result = await isCollectionChangeGated("user1", undefined, "weapons");
    expect(result).toBe(false);
    expect(mockGetUserPlan).not.toHaveBeenCalled();
  });

  it("is not gated and never calls getUserPlan when clearing to null", async () => {
    const result = await isCollectionChangeGated("user1", null, "weapons");
    expect(result).toBe(false);
    expect(mockGetUserPlan).not.toHaveBeenCalled();
  });

  it("is not gated and never calls getUserPlan when resubmitting the current value", async () => {
    const result = await isCollectionChangeGated("user1", "weapons", "weapons");
    expect(result).toBe(false);
    expect(mockGetUserPlan).not.toHaveBeenCalled();
  });

  it("is gated when assigning a NEW value on the basic plan", async () => {
    mockGetUserPlan.mockResolvedValue("basic");
    const result = await isCollectionChangeGated("user1", "weapons", null);
    expect(result).toBe(true);
    expect(mockGetUserPlan).toHaveBeenCalledWith("user1");
  });

  it("is gated when changing from one pack to a different pack on the basic plan", async () => {
    mockGetUserPlan.mockResolvedValue("basic");
    const result = await isCollectionChangeGated("user1", "armor", "weapons");
    expect(result).toBe(true);
  });

  it.each(["support", "patron", "twitch_sub"] as const)(
    "is NOT gated for a NEW value on the %s plan",
    async (plan) => {
      mockGetUserPlan.mockResolvedValue(plan);
      const result = await isCollectionChangeGated("user1", "weapons", null);
      expect(result).toBe(false);
    }
  );
});
