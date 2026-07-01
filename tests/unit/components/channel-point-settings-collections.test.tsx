import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import ChannelPointSettings from "@/components/ChannelPointSettings";
import jaMessages from "../../../messages/ja.json";

vi.mock("@/lib/logger");

// Issue #393: verify the card-pack dropdowns are actually populated.
// Regression guard for the original PR #448 defect where fetchCollectionNames
// was never invoked (C1) and hit the wrong endpoint/shape (C2).

type FetchMock = ReturnType<typeof vi.fn>;

function mockFetch(): FetchMock {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();

    if (url.includes("/api/cards/collections")) {
      return new Response(JSON.stringify({ collections: ["characters", "weapons"] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/api/twitch/channel-point-bootstrap")) {
      return new Response(
        JSON.stringify({
          hasRequiredScope: true,
          requiresReauth: false,
          rewards: [{ id: "main-reward", title: "Main", cost: 100, is_enabled: true }],
          subscriptions: [],
          additionalRewards: [],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    // Any other endpoint: respond with a benign empty payload.
    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  return fetchMock;
}

function renderComponent() {
  return render(
    <NextIntlClientProvider locale="ja" messages={jaMessages}>
      <ChannelPointSettings
        streamerId="streamer-1"
        currentRewardId="main-reward"
        currentRewardName="Main"
        currentCollectionName={null}
      />
    </NextIntlClientProvider>
  );
}

describe("ChannelPointSettings card pack dropdowns", () => {
  let fetchMock: FetchMock;

  beforeEach(() => {
    fetchMock = mockFetch();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches /api/cards/collections with the streamerId on mount", async () => {
    renderComponent();

    await waitFor(() => {
      const called = fetchMock.mock.calls.some(([input]) => {
        const url = typeof input === "string" ? input : String(input);
        return url.includes("/api/cards/collections?streamerId=streamer-1");
      });
      expect(called).toBe(true);
    });
  });

  it("renders the fetched pack names as <option>s", async () => {
    renderComponent();

    await waitFor(() => {
      // Both the main-reward and additional-reward selects list the packs,
      // so each name appears at least once.
      expect(screen.getAllByRole("option", { name: "weapons" }).length).toBeGreaterThan(0);
      expect(screen.getAllByRole("option", { name: "characters" }).length).toBeGreaterThan(0);
    });
  });

  // Issue #393再設計: パック選択はもうゲート対象外(新規登録はパック管理
  // モーダル側でのみ発生する)。選択肢は常に有効(disabledではない)。
  it("does not disable pack options (selection is never gated here)", async () => {
    renderComponent();

    await waitFor(() => {
      const options = screen.getAllByRole("option", { name: "weapons" }) as HTMLOptionElement[];
      expect(options.length).toBeGreaterThan(0);
      options.forEach((option) => expect(option.disabled).toBe(false));
    });
  });
});
