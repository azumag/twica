import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import ChannelPointsAccessSection from "@/components/ChannelPointsAccessSection";
import { MaintenanceStatusContext } from "@/components/MaintenanceStatusProvider";
import type { MaintenanceStatusResponse } from "@/lib/maintenance/client";
import { CHANNEL_POINT_SCOPES } from "@/lib/twitch/scopes";
import jaMessages from "../../../messages/ja.json";
import enMessages from "../../../messages/en.json";

// GitHub issue #788/#792: 非Affiliate配信者向けChannel Points利用可否確認・
// 明示的オプトインセクション (src/components/ChannelPointsAccessSection.tsx) の単体テスト。
//
// 既存の類似コンポーネントテストと同じ規約に揃えている:
//   - tests/unit/components/twitch-sub-check-section-maintenance.test.tsx
//     (fetchベースの状態管理・maintenanceゲーティング・再認証フローの型)
//   - tests/unit/components/channel-point-settings-maintenance.test.tsx
//     (URLディスパッチ式のfetchモックパターン)
// アサーションは messages/ja.json の実翻訳文字列をハードコードして使う
// （上記2ファイルの慣例。next-intlの補間・改行等の差異による誤検知を避けるため、
// 独自に組み立てた偽文字列ではなく実ファイルの値をそのままコピーしている）。

// useRouter().refresh を呼び出しごとに検証したいため、vi.hoisted で
// モジュール全体から参照できる単一のモック関数を用意する。
// （vi.mock ファクトリはファイル先頭にホイストされるため、参照する変数も
// vi.hoisted で包む必要がある。同じパターンを本リポジトリの他テストでも使用）
const routerMocks = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => routerMocks,
}));

// 実際に画面へ表示される日本語文言。messages/ja.json の channelPointsAccess キー
// (末尾付近) からそのままコピーしたもの。ja.json が変更されたら要追随。
const JA = {
  loading: "確認状況を読み込み中...",
  affiliateMessage: "Twitchアフィリエイト/パートナーとして、既に配信者機能を利用できます。",
  reauthMessage: "チャネルポイントの利用可否を確認するには、Twitchでの追加権限の許可が必要です。",
  reauthButton: "Twitchと再連携して確認",
  availableMessage: "Twitch上でチャネルポイントを利用できることを確認しました。",
  availableEnableButton: "twicaで配信者機能を有効にする",
  enabledMessage: "配信者機能が有効化されています。",
  enabledSettingsLink: "配信設定を開く",
  unavailableMessage:
    "現在Twitch上でチャネルポイントを利用できません。Twitch Creator Dashboardで収益化オンボーディングとチャネルポイント設定をご確認ください。",
  unavailableRecheckButton: "再判定",
  checkingMessage: "Twitchへ確認中です...",
  unknownMessage: "Twitchへの確認に一時的に失敗しました。保存済みの状態は変わっていません。",
  unknownRetryButton: "再試行",
  capabilityLostWarning: "Channel Points操作には再認証・再判定が必要です。配信設定自体は引き続き利用できます。",
  enableSuccess: "配信者機能を有効化しました。",
  enableSuccessSessionPending:
    "配信者機能を有効化しました。ただしセッションの更新に失敗したため、反映には再ログインが必要な場合があります。",
  enableFailed: "有効化に失敗しました。時間をおいて再試行してください。",
  genericError: "エラーが発生しました。時間をおいて再試行してください。",
  maintenanceWriteDisabled: "メンテナンス中は操作できません",
} as const;

// GET /api/account/channel-points のレスポンス形状。コンポーネント本体は
// このinterfaceをexportしていないため、テスト側で最小限を複製する。
type Capability = "available" | "unavailable" | "reauth_required" | "unknown";
interface AccessState {
  broadcasterType: string;
  capability: Capability;
  capabilityCheckedAt: string | null;
  enabled: boolean;
  hasRequiredScope: boolean;
  requiresReauth: boolean;
  stale: boolean;
  canEnable: boolean;
}

function makeState(overrides: Partial<AccessState> = {}): AccessState {
  return {
    broadcasterType: "",
    capability: "unknown",
    capabilityCheckedAt: null,
    enabled: false,
    hasRequiredScope: false,
    requiresReauth: false,
    stale: false,
    canEnable: false,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// GET/POST/PUT (/api/account/channel-points) と POST /api/auth/reauth を
// URL・methodで振り分けるfetchモック。未指定のハンドラはchannel-point-settings-
// maintenance.test.tsx と同様、素の200 `{}` を返す。
function buildFetchMock(handlers: {
  get?: () => Response | Promise<Response>;
  post?: (init?: RequestInit) => Response | Promise<Response>;
  put?: (init?: RequestInit) => Response | Promise<Response>;
  reauth?: (init?: RequestInit) => Response | Promise<Response>;
}) {
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();

    if (url.includes("/api/account/channel-points")) {
      if (method === "GET") {
        return Promise.resolve((handlers.get ?? (() => jsonResponse(makeState())))());
      }
      if (method === "POST" && handlers.post) {
        return Promise.resolve(handlers.post(init));
      }
      if (method === "PUT" && handlers.put) {
        return Promise.resolve(handlers.put(init));
      }
    }
    if (url.includes("/api/auth/reauth") && handlers.reauth) {
      return Promise.resolve(handlers.reauth(init));
    }
    return Promise.resolve(jsonResponse({}));
  });
}

function buildTree(
  status: MaintenanceStatusResponse,
  props: { broadcasterType?: string; initialEnabled?: boolean } = {}
) {
  return (
    <NextIntlClientProvider locale="ja" messages={jaMessages}>
      <MaintenanceStatusContext.Provider value={status}>
        <ChannelPointsAccessSection
          broadcasterType={props.broadcasterType ?? ""}
          initialEnabled={props.initialEnabled ?? false}
        />
      </MaintenanceStatusContext.Provider>
    </NextIntlClientProvider>
  );
}

function renderSection(
  status: MaintenanceStatusResponse,
  props: { broadcasterType?: string; initialEnabled?: boolean } = {}
) {
  return render(buildTree(status, props));
}

// happy-dom の window.location をテスト間で安全に差し替え/復元するための元の参照。
// #569 (overlay-page.test.tsx) と同じ方針: hrefはgetter/setterではなく
// プレーンなプロパティを持つ差し替えオブジェクトにするため、代入(`location.href = x`)
// をそのまま観測できる。
const ORIGINAL_LOCATION = window.location;

function stubLocationHref() {
  const current = window.location;
  Object.defineProperty(window, "location", {
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
    configurable: true,
  });
}

describe("ChannelPointsAccessSection", () => {
  beforeEach(() => {
    routerMocks.refresh.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    // stubLocationHref() を使ったテストが失敗して復元処理まで到達しなかった
    // 場合でも、以降のテストに影響を残さないよう毎回無条件に復元する。
    Object.defineProperty(window, "location", { value: ORIGINAL_LOCATION, configurable: true });
  });

  it("初回GET解決前はローディング表示のみで、アクションボタンは描画されない", async () => {
    let resolveGet!: (value: Response) => void;
    const pendingGet = new Promise<Response>((resolve) => {
      resolveGet = resolve;
    });
    vi.stubGlobal("fetch", buildFetchMock({ get: () => pendingGet }));

    renderSection({ mode: "off" });

    expect(screen.getByText(JA.loading)).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();

    // pending中のPromiseを残したままテストを終えるとactの外での警告や後続テストへの
    // 汚染につながるため、明示的に解決してから終える。
    resolveGet(jsonResponse(makeState({ capability: "available", hasRequiredScope: true })));
    await waitFor(() => expect(screen.queryByText(JA.loading)).not.toBeInTheDocument());
  });

  it.each(["affiliate", "partner"] as const)(
    "broadcasterType=%s の場合はAffiliateメッセージと設定リンクのみを表示し、有効化ボタンは出さない",
    async (broadcasterType) => {
      vi.stubGlobal(
        "fetch",
        buildFetchMock({
          get: () =>
            jsonResponse(
              makeState({ broadcasterType, enabled: false, hasRequiredScope: true, capability: "unknown" })
            ),
        })
      );

      renderSection({ mode: "off" }, { broadcasterType });

      expect(await screen.findByText(JA.affiliateMessage)).toBeInTheDocument();
      const link = screen.getByRole("link", { name: JA.enabledSettingsLink });
      expect(link).toHaveAttribute("href", "/dashboard/settings");
      // Affiliate分岐にはボタン要素が一切存在しない(リンクのみ)ことを確認する
      expect(screen.queryByRole("button")).not.toBeInTheDocument();
    }
  );

  it("スコープ不足/要再認証の場合は再認証メッセージとボタンを表示し、クリックでPOST /api/auth/reauthを正しいbodyで呼ぶ", async () => {
    stubLocationHref();
    const reauthHandler = vi.fn((init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      expect(body).toEqual({
        additionalScopes: CHANNEL_POINT_SCOPES,
        returnTo: "/dashboard/account",
      });
      const redirectUri = encodeURIComponent(`${window.location.origin}/api/auth/twitch/callback`);
      return jsonResponse({
        loginUrl: `https://id.twitch.tv/oauth2/authorize?mock=1&redirect_uri=${redirectUri}&state=abc12345`,
        state: "abc12345",
      });
    });
    vi.stubGlobal(
      "fetch",
      buildFetchMock({
        get: () => jsonResponse(makeState({ hasRequiredScope: false, requiresReauth: true, stale: false })),
        reauth: reauthHandler,
      })
    );

    renderSection({ mode: "off" });

    expect(await screen.findByText(JA.reauthMessage)).toBeInTheDocument();
    const button = screen.getByRole("button", { name: JA.reauthButton });
    fireEvent.click(button);

    await waitFor(() => expect(reauthHandler).toHaveBeenCalledTimes(1));
    const redirectUri = encodeURIComponent(`${window.location.origin}/api/auth/twitch/callback`);
    await waitFor(() =>
      expect(window.location.href).toBe(
        `https://id.twitch.tv/oauth2/authorize?mock=1&redirect_uri=${redirectUri}&state=abc12345`
      )
    );
  });

  it("reauth APIの200応答に有効なTwitch loginUrlがなければ遷移せず汎用エラーを表示する（Issue #865フォローアップ）", async () => {
    stubLocationHref();
    const originalHref = window.location.href;
    vi.stubGlobal(
      "fetch",
      buildFetchMock({
        get: () => jsonResponse(makeState({ hasRequiredScope: false, requiresReauth: true, stale: false })),
        // origin/pathがTwitchの認可endpointと一致しない、侵害/バグ時を想定した応答
        reauth: () => jsonResponse({ loginUrl: "https://evil.example.com/phish", state: "abc12345" }),
      })
    );

    renderSection({ mode: "off" });

    const button = await screen.findByRole("button", { name: JA.reauthButton });
    fireEvent.click(button);

    expect(await screen.findByText(JA.genericError)).toBeInTheDocument();
    expect(window.location.href).toBe(originalHref);
  });

  it("non-affiliate + スコープ有 + stale の場合、ユーザー操作なしで自動的に1回だけPOST /api/account/channel-pointsが発火する", async () => {
    const postHandler = vi.fn(() => jsonResponse({}));
    const getHandler = vi.fn(() =>
      jsonResponse(makeState({ hasRequiredScope: true, stale: true, capability: "unknown" }))
    );
    vi.stubGlobal("fetch", buildFetchMock({ get: getHandler, post: postHandler }));

    const { rerender } = renderSection({ mode: "off" });

    await waitFor(() => expect(postHandler).toHaveBeenCalledTimes(1));
    // runProbe() は成功後finally節で必ずfetchState()(GET)を呼び直す設計のため、
    // checking表示が終わって再判定ボタンが戻ってくるまで待つことで、そのGETも
    // 含めた一連の非同期チェーンが完全に片付いたことを保証する
    // (afterEachでのfetchモック解除より前に未解決のfetch呼び出しを残さないため)。
    await screen.findByRole("button", { name: JA.unknownRetryButton });

    // 追加の再render(Strict Modeの二重effect実行相当の懸念)を発生させても、
    // 同一コンポーネントインスタンスに対するrerenderであるため新規mountは起きず、
    // autoProbeStarted(useRef)ガードにより再発火しないことを確認する。
    rerender(buildTree({ mode: "off" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(postHandler).toHaveBeenCalledTimes(1);
  });

  it("stale:false の場合は自動POSTが発火しない", async () => {
    const postHandler = vi.fn(() => jsonResponse({}));
    vi.stubGlobal(
      "fetch",
      buildFetchMock({
        get: () => jsonResponse(makeState({ hasRequiredScope: true, stale: false, capability: "unknown" })),
        post: postHandler,
      })
    );

    renderSection({ mode: "off" });

    await screen.findByText(JA.unknownMessage);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(postHandler).not.toHaveBeenCalled();
  });

  it("Affiliateの場合はstale:trueでも自動POSTが発火しない(コンポーネント側ガードの防御的検証)", async () => {
    const postHandler = vi.fn(() => jsonResponse({}));
    vi.stubGlobal(
      "fetch",
      buildFetchMock({
        get: () =>
          jsonResponse(
            makeState({ broadcasterType: "affiliate", hasRequiredScope: true, stale: true })
          ),
        post: postHandler,
      })
    );

    renderSection({ mode: "off" }, { broadcasterType: "affiliate" });

    await screen.findByText(JA.affiliateMessage);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(postHandler).not.toHaveBeenCalled();
  });

  it("available状態で有効化ボタンをクリックするとPUTを呼び、成功メッセージ・router.refresh・GET再取得を行う", async () => {
    let getCallCount = 0;
    const getHandler = vi.fn(() => {
      getCallCount += 1;
      if (getCallCount === 1) {
        return jsonResponse(
          makeState({ capability: "available", enabled: false, hasRequiredScope: true, canEnable: true })
        );
      }
      return jsonResponse(makeState({ capability: "available", enabled: true, hasRequiredScope: true }));
    });
    const putHandler = vi.fn(() => jsonResponse({ code: "enabled", enabled: true, streamerId: "uuid-1" }));
    vi.stubGlobal("fetch", buildFetchMock({ get: getHandler, put: putHandler }));

    renderSection({ mode: "off" });

    const enableButton = await screen.findByRole("button", { name: JA.availableEnableButton });
    fireEvent.click(enableButton);

    await waitFor(() => expect(putHandler).toHaveBeenCalledTimes(1));
    // 実装は setMessage(成功) → await fetchState()(GET) → router.refresh() の順で
    // 実行される。成功メッセージの描画はfetchState/refreshより先に起こりうるため、
    // 「メッセージが見える」ことをもって後続処理の完了を仮定せず、
    // router.refresh呼び出しとGET再取得の両方を個別にwaitForで待つ
    // (afterEachでfetchモックが解除される前に非同期チェーンを完全に片付けるため)。
    await waitFor(() => expect(screen.getByText(JA.enableSuccess)).toBeInTheDocument());
    await waitFor(() => expect(getHandler).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(routerMocks.refresh).toHaveBeenCalledTimes(1));
  });

  // 自動レビュー(claude[bot])指摘 Major-2: PUTがDB更新成功だがsession cookie再署名に
  // 失敗した場合、サーバーはstatus 500 + { code: 'session_resync_failed', enabled: true }
  // を返す。response.okだけで成功判定すると「失敗」と誤表示され、直後のGETで
  // enabled:trueが表示されて矛盾する。data.enabled===trueを見て成功扱いすることを確認する。
  it("PUTがsession_resync_failed(500だがenabled:true)を返した場合も成功として表示し、GET再取得・router.refreshを行う", async () => {
    let getCallCount = 0;
    const getHandler = vi.fn(() => {
      getCallCount += 1;
      if (getCallCount === 1) {
        return jsonResponse(
          makeState({ capability: "available", enabled: false, hasRequiredScope: true, canEnable: true })
        );
      }
      return jsonResponse(makeState({ capability: "available", enabled: true, hasRequiredScope: true }));
    });
    const putHandler = vi.fn(() =>
      jsonResponse({ code: "session_resync_failed", enabled: true, error: "..." }, 500)
    );
    vi.stubGlobal("fetch", buildFetchMock({ get: getHandler, put: putHandler }));

    renderSection({ mode: "off" });

    const enableButton = await screen.findByRole("button", { name: JA.availableEnableButton });
    fireEvent.click(enableButton);

    await waitFor(() => expect(putHandler).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText(JA.enableSuccessSessionPending)).toBeInTheDocument());
    // 「有効化に失敗しました」という矛盾したエラー文言は表示されない
    expect(screen.queryByText(JA.enableFailed)).not.toBeInTheDocument();
    await waitFor(() => expect(getHandler).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(routerMocks.refresh).toHaveBeenCalledTimes(1));
  });

  it("unavailable状態では案内メッセージ(Twitch Creator Dashboard誘導)と再判定ボタンを表示し、クリックでPOSTが呼ばれる", async () => {
    const postHandler = vi.fn(() => jsonResponse({}));
    vi.stubGlobal(
      "fetch",
      buildFetchMock({
        get: () =>
          jsonResponse(
            makeState({ capability: "unavailable", enabled: false, hasRequiredScope: true, stale: false })
          ),
        post: postHandler,
      })
    );

    renderSection({ mode: "off" });

    const message = await screen.findByText(JA.unavailableMessage);
    expect(message).toBeInTheDocument();
    // 撤去済みのはずの旧文言("Affiliate required"等)が復活していないことの防御的確認。
    // 実文言はTwitch Creator Dashboardでのオンボーディング確認を案内する内容である。
    expect(message.textContent).not.toMatch(/Affiliate required/i);
    expect(message.textContent).toContain("Creator Dashboard");

    const recheckButton = screen.getByRole("button", { name: JA.unavailableRecheckButton });
    fireEvent.click(recheckButton);

    await waitFor(() => expect(postHandler).toHaveBeenCalledTimes(1));
    // runProbe()はfinally節で必ずfetchState()(GET)を呼び直してからchecking状態を
    // 解除する。再判定ボタンが復帰するまで待つことで、そのGETも含めた一連の
    // 非同期チェーンが完全に片付いたことを保証する
    // (afterEachでのfetchモック解除より前に未解決のfetch呼び出しを残さないため)。
    await screen.findByRole("button", { name: JA.unavailableRecheckButton });
  });

  it("自動probeが一時失敗しても、直前の確定状態(capabilityCheckedAt)を消さずunknown/再試行を表示する", async () => {
    const CHECKED_AT = "2026-01-01T00:00:00Z";
    // POSTのレスポンスbody自体はコンポーネントの実装上は使われず(finally節で
    // 常にfetchStateを呼び直す設計)、その後のGETが返す「persisted」な状態が
    // 画面表示を決定する。よってGET側に一時失敗後も保持されるはずの
    // capability:'unknown' + capabilityCheckedAt(非null)を返させる。
    const getHandler = vi.fn(() =>
      jsonResponse(
        makeState({
          hasRequiredScope: true,
          stale: true,
          capability: "unknown",
          capabilityCheckedAt: CHECKED_AT,
        })
      )
    );
    const postHandler = vi.fn(() =>
      jsonResponse({
        code: "probe_temporarily_failed",
        probe: { definitive: false },
        persisted: { capability: "unknown", capabilityCheckedAt: CHECKED_AT },
      })
    );
    vi.stubGlobal("fetch", buildFetchMock({ get: getHandler, post: postHandler }));

    renderSection({ mode: "off" });

    await waitFor(() => expect(postHandler).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(JA.unknownMessage)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: JA.unknownRetryButton })).toBeInTheDocument();
    expect(screen.queryByText(JA.unavailableMessage)).not.toBeInTheDocument();
  });

  it.each([
    { requiresReauth: true, capability: "unknown" as const },
    { requiresReauth: false, capability: "unavailable" as const },
  ])(
    "有効化済み(enabled:true)でcapabilityを喪失した場合、設定リンクと再認証/再判定案内を両方表示する (requiresReauth=$requiresReauth, capability=$capability)",
    async ({ requiresReauth, capability }) => {
      vi.stubGlobal(
        "fetch",
        buildFetchMock({
          get: () =>
            jsonResponse(
              makeState({ enabled: true, requiresReauth, capability, hasRequiredScope: !requiresReauth })
            ),
        })
      );

      renderSection({ mode: "off" }, { initialEnabled: true });

      expect(await screen.findByText(JA.enabledMessage)).toBeInTheDocument();
      // ユーザーがロックアウトされないこと(設定リンクは引き続き表示される)
      expect(screen.getByRole("link", { name: JA.enabledSettingsLink })).toBeInTheDocument();
      // かつ再認証/再判定が必要という警告も同時に表示される(どちらか一方ではない)
      expect(screen.getByText(JA.capabilityLostWarning)).toBeInTheDocument();
    }
  );

  it("メンテナンス中は有効化ボタンがdisabledになり、クリックしてもPUTは呼ばれない(UI無効化 + handler側ガードの多重防御)", async () => {
    const putHandler = vi.fn(() => jsonResponse({ code: "enabled", enabled: true, streamerId: "uuid-1" }));
    vi.stubGlobal(
      "fetch",
      buildFetchMock({
        get: () => jsonResponse(makeState({ capability: "available", enabled: false, hasRequiredScope: true })),
        put: putHandler,
      })
    );

    renderSection({ mode: "read-only" });

    const enableButton = await screen.findByRole("button", { name: JA.availableEnableButton });
    expect(enableButton).toBeDisabled();
    expect(screen.getByText(JA.maintenanceWriteDisabled)).toBeInTheDocument();

    fireEvent.click(enableButton);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(putHandler).not.toHaveBeenCalled();
  });

  it("有効化(PUT)がobject形状のerrorボディで失敗しても、[object Object]という文字列を描画せず翻訳済みの汎用エラーにフォールバックする", async () => {
    // handleEnable の失敗パスは data.error を一切参照せず、常に
    // t("messages.enableFailed") (またはparseMaintenanceErrorのmessage)に
    // フォールバックする実装になっている。data.errorがオブジェクト形状でも
    // 無視されるため、フォールバック文言が安全に描画されることを確認する。
    const getHandler = vi.fn(() =>
      jsonResponse(makeState({ capability: "available", enabled: false, hasRequiredScope: true }))
    );
    const putHandler = vi.fn(() =>
      jsonResponse({ error: { code: "some_code", message: "Something failed" }, enabled: false }, 200)
    );
    vi.stubGlobal("fetch", buildFetchMock({ get: getHandler, put: putHandler }));

    renderSection({ mode: "off" });

    const enableButton = await screen.findByRole("button", { name: JA.availableEnableButton });
    fireEvent.click(enableButton);

    await waitFor(() => expect(putHandler).toHaveBeenCalledTimes(1));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).not.toContain("[object Object]");
    expect(alert.textContent).not.toContain("object Object");
    // 失敗パスもfinally節で必ずfetchState()(GET)を呼び直してから完了する。
    // それを待つことで、afterEachでのfetchモック解除より前に未解決のfetch呼び出しを
    // 残さないようにする。
    await waitFor(() => expect(getHandler).toHaveBeenCalledTimes(2));
  });

  describe("channelPointsAccess i18n キーの ja/en 両対応 (コンポーネントが実際に t() で参照するキーのみ)", () => {
    // src/components/ChannelPointsAccessSection.tsx を grep して収集した、
    // useTranslations("channelPointsAccess") 経由で呼ばれる全キーパス。
    // キーを追加/削除した場合はこの配列も追随させること。
    const CHANNEL_POINTS_ACCESS_KEYS = [
      "title",
      "loading",
      "description",
      "affiliate.message",
      "reauth.message",
      "reauth.button",
      "reauth.buttonLoading",
      "checking.message",
      "available.message",
      "available.enableDescription",
      "available.enableButton",
      "available.enableButtonLoading",
      "enabled.message",
      "enabled.settingsLink",
      "unavailable.message",
      "unavailable.recheckButton",
      "unknown.message",
      "unknown.retryButton",
      "capabilityLostWarning",
      "messages.enableSuccess",
      "messages.enableSuccessSessionPending",
      "messages.enableFailed",
      "messages.genericError",
    ];

    function getByPath(obj: unknown, path: string): unknown {
      return path.split(".").reduce<unknown>((acc, key) => {
        if (typeof acc !== "object" || acc === null) return undefined;
        return (acc as Record<string, unknown>)[key];
      }, obj);
    }

    it.each(CHANNEL_POINTS_ACCESS_KEYS)("ja/en 両方に channelPointsAccess.%s が非空文字列として存在する", (key) => {
      const jaValue = getByPath((jaMessages as { channelPointsAccess: unknown }).channelPointsAccess, key);
      const enValue = getByPath((enMessages as { channelPointsAccess: unknown }).channelPointsAccess, key);

      expect(typeof jaValue).toBe("string");
      expect((jaValue as string).length).toBeGreaterThan(0);
      expect(typeof enValue).toBe("string");
      expect((enValue as string).length).toBeGreaterThan(0);
    });

    // tMaintenance("writeDisabled") もコンポーネントが実際に呼ぶキー
    it("ja/en 両方に maintenance.writeDisabled が非空文字列として存在する", () => {
      expect(jaMessages.maintenance.writeDisabled.length).toBeGreaterThan(0);
      expect(enMessages.maintenance.writeDisabled.length).toBeGreaterThan(0);
    });
  });

  it("fetch未解決中にunmountしても、アンマウント後のReact state更新警告を出さない", async () => {
    let resolveGet!: (value: Response) => void;
    const pendingGet = new Promise<Response>((resolve) => {
      resolveGet = resolve;
    });
    vi.stubGlobal("fetch", buildFetchMock({ get: () => pendingGet }));
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { unmount } = renderSection({ mode: "off" });
    unmount();
    resolveGet(jsonResponse(makeState({ capability: "available", hasRequiredScope: true })));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const unmountedWarnings = consoleErrorSpy.mock.calls.filter(
      ([msg]) => typeof msg === "string" && msg.includes("unmounted component")
    );
    expect(unmountedWarnings).toHaveLength(0);
    consoleErrorSpy.mockRestore();
  });
});
