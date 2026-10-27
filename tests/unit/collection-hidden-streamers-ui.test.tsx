/**
 * #1953: マイコレクション一覧の並び替えリンクと「非表示のコレクション」セクション、
 * および非表示/再表示ボタン。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import Collection from "@/components/Collection";
import CollectionHideButton from "@/components/CollectionHideButton";
import type { Streamer } from "@/types/database";

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  postTradeJson: vi.fn(),
}));

vi.mock("next-intl/server", () => ({
  // キー名と、ICU 引数があればそれも文字列化して返す（件数の表示を検証できるように）
  getTranslations: async () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}));
vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mocks.refresh }),
}));
vi.mock("@/lib/trade-client", () => ({
  postTradeJson: mocks.postTradeJson,
}));

function entry(id: string, name: string) {
  return {
    streamer: {
      id,
      twitch_display_name: name,
      twitch_profile_image_url: null,
    } as unknown as Streamer,
    cards: [],
    totalActive: 4,
    ownedActive: 1,
    isComplete: false,
  };
}

describe("Collection: 並び替えと非表示セクション (#1953)", () => {
  it("2件以上あるとき3つの並び替えリンクを出し、現在のモードに aria-current を付ける", async () => {
    render(
      await Collection({
        cardsByStreamer: { a: entry("a", "Alpha"), b: entry("b", "Bravo") },
        sortMode: "name",
      }),
    );

    const recent = screen.getByRole("link", { name: "sort.recent" });
    const name = screen.getByRole("link", { name: "sort.name" });
    const completion = screen.getByRole("link", { name: "sort.completion" });
    // 既定(recent)は URL にクエリを付けない
    expect(recent).toHaveAttribute("href", "/dashboard/collection");
    expect(name).toHaveAttribute("href", "/dashboard/collection?sort=name");
    expect(completion).toHaveAttribute("href", "/dashboard/collection?sort=completion");
    expect(name).toHaveAttribute("aria-current", "true");
    expect(recent).not.toHaveAttribute("aria-current");
  });

  it("表示対象が1件以下なら並び替えUIを出さない", async () => {
    render(await Collection({ cardsByStreamer: { a: entry("a", "Alpha") } }));
    expect(screen.queryByRole("link", { name: "sort.name" })).toBeNull();
  });

  it("cardsByStreamer の順（page 側で並び替え済み）のまま表示する", async () => {
    render(
      await Collection({
        cardsByStreamer: { b: entry("b", "Bravo"), a: entry("a", "Alpha") },
      }),
    );
    const headings = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
    expect(headings).toEqual(["Bravo", "Alpha"]);
  });

  it("非表示の配信者は <details> の中に件数つきで出し、再表示ボタン(hide=false)になる", async () => {
    const { container } = render(
      await Collection({
        cardsByStreamer: { a: entry("a", "Alpha") },
        hiddenCardsByStreamer: { h: entry("h", "Hidden One"), i: entry("i", "Hidden Two") },
      }),
    );

    const details = container.querySelector("details");
    expect(details).not.toBeNull();
    // 既定は折りたたみ
    expect(details).not.toHaveAttribute("open");
    expect(details!.querySelector("summary")!.textContent).toBe('hidden.summary:{"count":2}');
    expect(details!.textContent).toContain("Hidden One");
    expect(details!.textContent).toContain("Hidden Two");
    // 通常一覧側（details の外）には非表示の配信者が出ない
    const outside = Array.from(container.querySelectorAll("h3"))
      .filter((h) => !details!.contains(h))
      .map((h) => h.textContent);
    expect(outside).toEqual(["Alpha"]);
    // 非表示中でも直リンク（コレクションを見る）は残る
    expect(
      details!.querySelector('a[href="/collection/h"]'),
    ).not.toBeNull();
  });

  it("通常カードは「非表示」ボタン、非表示セクションのカードは「再表示」ボタンを出す", async () => {
    render(
      await Collection({
        cardsByStreamer: { a: entry("a", "Alpha") },
        hiddenCardsByStreamer: { h: entry("h", "Hidden One") },
      }),
    );
    expect(screen.getByRole("button", { name: 'hideAria:{"name":"Alpha"}' })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: 'showAria:{"name":"Hidden One"}' })).toBeInTheDocument();
  });

  it("全件非表示のときは「カードが無い」空状態ではなく専用メッセージ＋非表示セクションを出す", async () => {
    const { container } = render(
      await Collection({
        cardsByStreamer: {},
        hiddenCardsByStreamer: { h: entry("h", "Hidden One") },
      }),
    );
    expect(screen.getByText("hidden.allHidden")).toBeInTheDocument();
    expect(screen.queryByText(/empty\.line1/)).toBeNull();
    expect(container.querySelector("details")).not.toBeNull();
  });

  it("カードが1枚も無いときだけ従来の空状態を出し、非表示セクションは出さない", async () => {
    const { container } = render(await Collection({ cardsByStreamer: {} }));
    expect(screen.getByText(/empty\.line1/)).toBeInTheDocument();
    expect(screen.queryByText("hidden.allHidden")).toBeNull();
    expect(container.querySelector("details")).toBeNull();
  });
});

describe("CollectionHideButton (#1953)", () => {
  beforeEach(() => {
    mocks.refresh.mockReset();
    mocks.postTradeJson.mockReset();
  });

  it("非表示ボタン: hidden=true でAPIを呼び、成功したら router.refresh() する", async () => {
    mocks.postTradeJson.mockResolvedValue({ ok: true, data: { success: true } });
    render(<CollectionHideButton streamerId="s-1" streamerName="Alpha" hide />);

    fireEvent.click(screen.getByRole("button"));

    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1));
    expect(mocks.postTradeJson).toHaveBeenCalledWith("/api/collection/hidden-streamers", {
      streamerId: "s-1",
      hidden: true,
    });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("再表示ボタン: hidden=false でAPIを呼ぶ", async () => {
    mocks.postTradeJson.mockResolvedValue({ ok: true, data: { success: true } });
    render(<CollectionHideButton streamerId="s-1" streamerName="Alpha" hide={false} />);

    fireEvent.click(screen.getByRole("button"));

    await waitFor(() => expect(mocks.postTradeJson).toHaveBeenCalled());
    expect(mocks.postTradeJson).toHaveBeenCalledWith("/api/collection/hidden-streamers", {
      streamerId: "s-1",
      hidden: false,
    });
  });

  it("送信中は disabled で二重送信できない", async () => {
    let resolvePost: (v: unknown) => void = () => {};
    mocks.postTradeJson.mockReturnValue(new Promise((r) => (resolvePost = r)));
    render(<CollectionHideButton streamerId="s-1" streamerName="Alpha" hide />);

    const button = screen.getByRole("button");
    fireEvent.click(button);
    await waitFor(() => expect(button).toBeDisabled());
    fireEvent.click(button);
    expect(mocks.postTradeJson).toHaveBeenCalledTimes(1);

    resolvePost({ ok: true, data: {} });
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalled());
  });

  it("失敗したらエラー表示を出し、refresh せず、再試行できる(disabled解除)", async () => {
    mocks.postTradeJson.mockResolvedValue({ ok: false, networkError: true });
    render(<CollectionHideButton streamerId="s-1" streamerName="Alpha" hide />);

    const button = screen.getByRole("button");
    fireEvent.click(button);

    expect(await screen.findByRole("alert")).toHaveTextContent("error");
    expect(mocks.refresh).not.toHaveBeenCalled();
    await waitFor(() => expect(button).not.toBeDisabled());
  });
});
