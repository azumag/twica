import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import ChannelPointSettings from "@/components/ChannelPointSettings";
import { MaintenanceStatusContext } from "@/components/MaintenanceStatusProvider";
import type { MaintenanceStatusResponse } from "@/lib/maintenance/client";
import jaMessages from "../../../messages/ja.json";

vi.mock("@/lib/logger");

// #694 Stage 6c: ChannelPointSettings の書き込み経路
// (POST /api/twitch/rewards の報酬作成、POST /api/streamer/settings +
// POST /api/twitch/eventsub/subscribe の保存フロー等) に対するmaintenance統合
// テスト。

type FetchMock = ReturnType<typeof vi.fn>;

function mockFetch(overrides: {
  rewards?: unknown[];
  createRewardStatus?: number;
  createRewardBody?: unknown;
  needsReauth?: boolean;
  reauthBody?: unknown;
  bootstrapStatus?: number;
  bootstrapBody?: unknown;
} = {}): FetchMock {
  const { rewards = [], createRewardStatus = 200, createRewardBody, needsReauth = false, reauthBody, bootstrapStatus = 200, bootstrapBody } = overrides;
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";

    if (url.includes("/api/cards/collections")) {
      return new Response(JSON.stringify({ collections: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/api/twitch/channel-point-bootstrap")) {
      // bootstrapBody指定時はそれを返す（401+requiresReauth等のエラー応答を再現するため）。
      const body =
        bootstrapBody ??
        {
          hasRequiredScope: !needsReauth,
          requiresReauth: needsReauth,
          rewards,
          subscriptions: [],
          additionalRewards: [],
          eventSubStatus: "none",
        };
      return new Response(JSON.stringify(body), {
        status: bootstrapStatus,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/api/twitch/rewards") && method === "POST") {
      return new Response(
        JSON.stringify(createRewardBody ?? { error: "unexpected" }),
        { status: createRewardStatus, headers: { "content-type": "application/json" } }
      );
    }
    if (url.includes("/api/auth/reauth") && method === "POST") {
      return new Response(JSON.stringify(reauthBody ?? { error: "unexpected" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
}

function renderComponent(
  status: MaintenanceStatusResponse,
  props: Partial<React.ComponentProps<typeof ChannelPointSettings>> = {}
) {
  return render(
    <NextIntlClientProvider locale="ja" messages={jaMessages}>
      <MaintenanceStatusContext.Provider value={status}>
        <ChannelPointSettings
          streamerId="streamer-1"
          currentRewardId={null}
          currentRewardName={null}
          {...props}
        />
      </MaintenanceStatusContext.Provider>
    </NextIntlClientProvider>
  );
}

const ORIGINAL_LOCATION = window.location;

function stubLocationHref() {
  const current = window.location;
  Object.defineProperty(window, "location", {
    configurable: true,
    value: {
      hash: current.hash,
      host: current.host,
      hostname: current.hostname,
      href: current.href,
      origin: current.origin,
      pathname: current.pathname,
      port: current.port,
      protocol: current.protocol,
      search: current.search,
    },
  });
}

describe("ChannelPointSettings maintenance integration", () => {
  let fetchMock: FetchMock;

  afterEach(() => {
    vi.unstubAllGlobals();
    Object.defineProperty(window, "location", { value: ORIGINAL_LOCATION, configurable: true });
  });

  it("reauth APIの200応答に有効なTwitch loginUrlがなければ遷移せず翻訳済みエラーを表示する（Issue #865フォローアップ）", async () => {
    stubLocationHref();
    const originalHref = window.location.href;
    // origin/pathがTwitchの認可endpointと一致しない、侵害/バグ時を想定した応答
    fetchMock = mockFetch({
      needsReauth: true,
      reauthBody: { loginUrl: "https://evil.example.com/phish", state: "state-1234" },
    });
    vi.stubGlobal("fetch", fetchMock);
    renderComponent({ mode: "off" });

    const button = await screen.findByRole("button", { name: "チャネルポイント連携を有効化" });
    fireEvent.click(button);

    expect(await screen.findByText("再認証に失敗しました。時間をおいて再度お試しください。")).toBeInTheDocument();
    expect(window.location.href).toBe(originalHref);
  });

  it("bootstrapが401+requiresReauthを返すと再連携バナー(CTA)を表示し、汎用エラーボックスは出ない（Issue #1018）", async () => {
    fetchMock = mockFetch({
      bootstrapStatus: 401,
      bootstrapBody: { error: "Twitch連携が必要です。再ログインしてください。", requiresReauth: true },
    });
    vi.stubGlobal("fetch", fetchMock);
    renderComponent({ mode: "off" });

    const button = await screen.findByRole("button", { name: "チャネルポイント連携を有効化" });
    expect(button).toBeInTheDocument();
    expect(
      screen.queryByText("チャネルポイント引き換えの取得に失敗しました。再度ログインしてください。")
    ).not.toBeInTheDocument();
  });

  it("bootstrapが401+requiresReauth以外(汎用エラー)のとき従来どおり赤いエラーボックスを表示する（Issue #1018フォールバック）", async () => {
    fetchMock = mockFetch({
      bootstrapStatus: 401,
      bootstrapBody: { error: "Internal Server Error" },
    });
    vi.stubGlobal("fetch", fetchMock);
    renderComponent({ mode: "off" });

    await waitFor(() => {
      expect(
        screen.getByText("チャネルポイント引き換えの取得に失敗しました。再度ログインしてください。")
      ).toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: "チャネルポイント連携を有効化" })).not.toBeInTheDocument();
  });

  it("mode=off のときは報酬作成ボタンが操作可能（既存挙動を壊さない）", async () => {
    fetchMock = mockFetch({ rewards: [] });
    vi.stubGlobal("fetch", fetchMock);
    renderComponent({ mode: "off" });

    const createButton = await screen.findByRole("button", { name: "TwiCa用チャネルポイント引き換えを作成（100ポイント）" });
    expect(createButton).not.toBeDisabled();
  });

  it("mode!=off のときは報酬作成ボタンがdisableされ、案内文言が表示される（事前disable）", async () => {
    fetchMock = mockFetch({ rewards: [] });
    vi.stubGlobal("fetch", fetchMock);
    renderComponent({ mode: "read-only" });

    const createButton = await screen.findByRole("button", { name: "TwiCa用チャネルポイント引き換えを作成（100ポイント）" });
    expect(createButton).toBeDisabled();
    expect(createButton).toHaveAttribute("title", "メンテナンス中は操作できません");
    expect(screen.getByText("メンテナンス中は操作できません")).toBeInTheDocument();
  });

  it("事前disableをすり抜けて報酬作成が503(maintenance)で拒否された場合、サーバーの案内文言を表示する", async () => {
    fetchMock = mockFetch({
      rewards: [],
      createRewardStatus: 503,
      createRewardBody: {
        error: {
          code: "maintenance_read_only",
          message: "ただいまメンテナンス中です。しばらくしてから再度お試しください。",
          retryable: true,
        },
      },
    });
    vi.stubGlobal("fetch", fetchMock);
    renderComponent({ mode: "off" });

    const createButton = await screen.findByRole("button", { name: "TwiCa用チャネルポイント引き換えを作成（100ポイント）" });
    fireEvent.click(createButton);

    await waitFor(() => {
      expect(
        screen.getByText("ただいまメンテナンス中です。しばらくしてから再度お試しください。")
      ).toBeInTheDocument();
    });
  });

  it("メイン保存ボタンはmode!=offでdisableされる", async () => {
    fetchMock = mockFetch({ rewards: [{ id: "main-reward", title: "Main", cost: 100, is_enabled: true }] });
    vi.stubGlobal("fetch", fetchMock);
    renderComponent({ mode: "read-only" }, { currentRewardId: "main-reward", currentRewardName: "Main" });

    const saveButton = await screen.findByRole("button", { name: "保存 & EventSub登録" });
    expect(saveButton).toBeDisabled();
    expect(saveButton).toHaveAttribute("title", "メンテナンス中は操作できません");
  });

  it("authorization_revoked のサブスクリプションがあるとき、バナー内に再連携ボタンを表示する（Issue #1019）", async () => {
    fetchMock = mockFetch({
      bootstrapBody: {
        hasRequiredScope: true,
        rewards: [{ id: "reward-1", title: "Reward1", cost: 100, is_enabled: true }],
        subscriptions: [
          {
            id: "sub-1",
            status: "authorization_revoked",
            type: "channel.channel_points_custom_reward_redemption.add",
            condition: { broadcaster_user_id: "user-1", reward_id: "reward-1" },
            transport: { callback: "https://example.com/api/twitch/eventsub" },
          },
        ],
        additionalRewards: [],
        eventSubStatus: "error",
        raidEventSubStatus: "active",
        raidGiftDrawCount: 0,
      },
    });
    vi.stubGlobal("fetch", fetchMock);
    renderComponent({ mode: "off" }, { currentRewardId: "reward-1", currentRewardName: "Reward1" });

    // バナー本文が表示される
    expect(await screen.findByText("認証が取り消されました")).toBeInTheDocument();
    // 同一バナー内に再連携CTAが存在する（従来はボタン無しだった）
    const button = await screen.findByRole("button", { name: "チャネルポイント連携を有効化" });
    expect(button).toBeInTheDocument();
    expect(button).not.toBeDisabled();
  });

  it("authorization_revoked バナー内の再連携ボタンは maintenance 中は disable される（Issue #1019）", async () => {
    fetchMock = mockFetch({
      bootstrapBody: {
        hasRequiredScope: true,
        rewards: [{ id: "reward-1", title: "Reward1", cost: 100, is_enabled: true }],
        subscriptions: [
          {
            id: "sub-1",
            status: "authorization_revoked",
            type: "channel.channel_points_custom_reward_redemption.add",
            condition: { broadcaster_user_id: "user-1", reward_id: "reward-1" },
            transport: { callback: "https://example.com/api/twitch/eventsub" },
          },
        ],
        additionalRewards: [],
        eventSubStatus: "error",
        raidEventSubStatus: "active",
        raidGiftDrawCount: 0,
      },
    });
    vi.stubGlobal("fetch", fetchMock);
    renderComponent({ mode: "read-only" }, { currentRewardId: "reward-1", currentRewardName: "Reward1" });

    const button = await screen.findByRole("button", { name: "チャネルポイント連携を有効化" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", "メンテナンス中は操作できません");
  });

  it("authorization_revoked バナー内の再連携ボタン押下失敗時もバナーが消えずエラーを表示する（Issue #1019 必須指摘）", async () => {
    stubLocationHref();
    const originalHref = window.location.href;
    fetchMock = mockFetch({
      bootstrapBody: {
        hasRequiredScope: true,
        rewards: [{ id: "reward-1", title: "Reward1", cost: 100, is_enabled: true }],
        subscriptions: [
          {
            id: "sub-1",
            status: "authorization_revoked",
            type: "channel.channel_points_custom_reward_redemption.add",
            condition: { broadcaster_user_id: "user-1", reward_id: "reward-1" },
            transport: { callback: "https://example.com/api/twitch/eventsub" },
          },
        ],
        additionalRewards: [],
        eventSubStatus: "error",
        raidEventSubStatus: "active",
        raidGiftDrawCount: 0,
      },
      reauthBody: { loginUrl: "https://evil.example.com/phish", state: "state-1234" },
    });
    vi.stubGlobal("fetch", fetchMock);
    renderComponent({ mode: "off" }, { currentRewardId: "reward-1", currentRewardName: "Reward1" });

    const button = await screen.findByRole("button", { name: "チャネルポイント連携を有効化" });
    fireEvent.click(button);

    // バナー自体は消えず、inline エラーが表示される（外側の赤いエラーボックスで置き換わらない）
    expect(await screen.findByText("再認証に失敗しました。時間をおいて再度お試しください。")).toBeInTheDocument();
    expect(screen.getByText("認証が取り消されました")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "チャネルポイント連携を有効化" })).toBeInTheDocument();
    expect(window.location.href).toBe(originalHref);
  });
});
