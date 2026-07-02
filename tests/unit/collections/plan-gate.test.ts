import { describe, it, expect, vi, beforeEach } from "vitest";
import { isNewCardPackNameAdditionGated } from "@/lib/plan-gate";
import { getUserPlan } from "@/lib/plan";

vi.mock("@/lib/plan");

const mockGetUserPlan = vi.mocked(getUserPlan);

describe("isNewCardPackNameAdditionGated (Issue #269再設計)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("is not gated and never calls getUserPlan when addedNames is empty (no-op or removal-only save)", async () => {
    const result = await isNewCardPackNameAdditionGated("user1", []);
    expect(result).toBe(false);
    expect(mockGetUserPlan).not.toHaveBeenCalled();
  });

  it("is gated when adding a new pack name on the basic plan", async () => {
    mockGetUserPlan.mockResolvedValue("basic");
    const result = await isNewCardPackNameAdditionGated("user1", ["weapons"]);
    expect(result).toBe(true);
    expect(mockGetUserPlan).toHaveBeenCalledWith("user1");
  });

  it.each(["support", "patron", "twitch_sub"] as const)(
    "is NOT gated when adding a new pack name on the %s plan",
    async (plan) => {
      mockGetUserPlan.mockResolvedValue(plan);
      const result = await isNewCardPackNameAdditionGated("user1", ["weapons"]);
      expect(result).toBe(false);
    }
  );

  it("is gated when adding multiple new pack names on the basic plan", async () => {
    mockGetUserPlan.mockResolvedValue("basic");
    const result = await isNewCardPackNameAdditionGated("user1", ["weapons", "armor"]);
    expect(result).toBe(true);
  });
});
