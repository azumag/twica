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

function mockFetch(collections: string[] = ["characters", "weapons"]): FetchMock {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();

    if (url.includes("/api/cards/collections")) {
      return new Response(JSON.stringify({ collections }), {
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
          // Issue #555: the additional-reward section (and its own pack select)
          // only renders when eventSubStatus === "active" — set it here so the
          // new "default pack only" option tests can see BOTH selects.
          eventSubStatus: "active",
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

  // Issue #555: a fixed "default pack only" option (collection_name IS NULL)
  // must appear alongside "all cards" and the registered pack names, in both
  // the main-reward and additional-reward selects.
  it('renders a "default pack only" option in both pack selects', async () => {
    renderComponent();

    await waitFor(() => {
      const options = screen.getAllByRole("option", { name: "デフォルトパック（未分類のカードのみ）" }) as HTMLOptionElement[];
      expect(options.length).toBe(2);
      options.forEach((option) => {
        expect(option.disabled).toBe(false);
        expect((option as HTMLOptionElement).value).toBe("__default__");
      });
    });
  });

  // Regression guard: DEFAULT_PACK_SENTINEL is never a registered pack name
  // (it's reserved), so the "orphaned/missing pack" fallback option must not
  // ALSO render a duplicate <option value="__default__"> labeled "missing" —
  // that would create two options sharing one value in the same <select>.
  it('does not render a duplicate "missing pack" option for the default-pack sentinel', async () => {
    render(
      <NextIntlClientProvider locale="ja" messages={jaMessages}>
        <ChannelPointSettings
          streamerId="streamer-1"
          currentRewardId="main-reward"
          currentRewardName="Main"
          currentCollectionName="__default__"
        />
      </NextIntlClientProvider>
    );

    await waitFor(() => {
      const defaultOptions = screen.getAllByRole("option", { name: "デフォルトパック（未分類のカードのみ）" });
      expect(defaultOptions.length).toBe(2);
    });
    expect(screen.queryByText(/登録解除済み/)).not.toBeInTheDocument();
  });

  // Issue #555 (review MINOR): a real pack literally named "__default__" could
  // have been registered BEFORE the reserved-name guard existed. If the API
  // response still contains such legacy names, fetchCollections must filter
  // them out defensively — otherwise the fixed DEFAULT_PACK_SENTINEL option and
  // the legacy pack would render duplicate <option>s sharing one value in the
  // same <select>, making the legacy pack unselectable.
  it("filters reserved (`__`-prefixed) names out of the API response so options never duplicate", async () => {
    vi.unstubAllGlobals();
    vi.stubGlobal("fetch", mockFetch(["characters", "weapons", "__default__", "__legacy"]));

    renderComponent();

    await waitFor(() => {
      // Normal packs render as usual (main + additional select = 2 each).
      expect(screen.getAllByRole("option", { name: "weapons" }).length).toBe(2);
    });
    // Exactly the two FIXED default-pack options remain — no third/fourth
    // option coming from the legacy "__default__" entry in the response.
    const defaultOptions = screen.getAllByRole("option", { name: "デフォルトパック（未分類のカードのみ）" }) as HTMLOptionElement[];
    expect(defaultOptions.length).toBe(2);
    // The raw reserved names never appear as option labels.
    expect(screen.queryByRole("option", { name: "__default__" })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "__legacy" })).not.toBeInTheDocument();
  });
});
