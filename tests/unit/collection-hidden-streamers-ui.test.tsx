/**
 * #1953: マイコレクション一覧の並び替え（サーバー往復なしの即時反映）と、
 * 「非表示のコレクション」セクション・非表示/再表示ボタン（楽観的更新）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import Collection from "@/components/Collection";
import CollectionHideButton from "@/components/CollectionHideButton";
import CollectionStreamerList, {
  type CollectionStreamerItem,
} from "@/components/CollectionStreamerList";
import type { StreamerCollectionSortMode } from "@/lib/collection-utils";
import type { Streamer } from "@/types/database";

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  postJsonWithCsrfRetry: vi.fn(),
  // useSearchParams が返すクエリ（URL の ?sort= を初期の並びにする挙動を検証する）
  search: "",
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
// 並び替えでは画面全体の再取得(router.refresh)をしないこと、非表示の保存成功後だけ裏で呼ぶことを
// 検証するため、呼ばれたら検出できるようにしておく
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mocks.refresh }),
  useSearchParams: () => new URLSearchParams(mocks.search),
}));
vi.mock("@/lib/collection-client", () => ({
  postJsonWithCsrfRetry: mocks.postJsonWithCsrfRetry,
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

function item(id: string, name: string): CollectionStreamerItem {
  return {
    id,
    body: <h3>{name}</h3>,
    viewLink: <a href={`/collection/${id}`}>view</a>,
    streamerName: name,
  };
}

const ITEMS = [item("a", "Alpha"), item("b", "Bravo"), item("c", "Charlie")];
// 3モードで順序が異なる並び（サーバーで確定済みの想定）
const ORDERS: Record<StreamerCollectionSortMode, string[]> = {
  recent: ["a", "b", "c"],
  name: ["c", "b", "a"],
  completion: ["b", "c", "a"],
};

/** 通常一覧（<details> の外）と非表示セクション（<details> の中）の h3 を順に取り出す。 */
function listed(container: HTMLElement) {
  const details = container.querySelector("details");
  const all = Array.from(container.querySelectorAll("h3"));
  return {
    visible: all.filter((h) => !details?.contains(h)).map((h) => h.textContent),
    hidden: all.filter((h) => details?.contains(h)).map((h) => h.textContent),
  };
}

function renderList(
  props: Partial<React.ComponentProps<typeof CollectionStreamerList>> = {},
  search = "",
) {
  mocks.search = search;
  return render(
    <CollectionStreamerList
      items={ITEMS}
      orders={ORDERS}
      initialHiddenIds={[]}
      {...props}
    />,
  );
}

beforeEach(() => {
  mocks.refresh.mockReset();
  mocks.postJsonWithCsrfRetry.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

describe("Collection (サーバーコンポーネント) (#1953)", () => {
  it("カード中身をサーバー描画して client の一覧に渡し、全体を orders の順で出す", async () => {
    const { container } = render(
      await Collection({
        cardsByStreamer: { a: entry("a", "Alpha"), b: entry("b", "Bravo") },
        orders: { recent: ["b", "a"], name: ["a", "b"], completion: ["a", "b"] },
        hiddenStreamerIds: ["a"],
      }),
    );
    expect(listed(container)).toEqual({ visible: ["Bravo"], hidden: ["Alpha"] });
    // 「コレクションを見る」リンクはサーバー描画のまま（非表示中も残る）
    expect(container.querySelector('a[href="/collection/a"]')).not.toBeNull();
    expect(container.querySelector('a[href="/collection/b"]')).not.toBeNull();
  });

  it("カードが1枚も無いときだけ従来の空状態を出し、非表示セクションは出さない", async () => {
    const { container } = render(await Collection({ cardsByStreamer: {} }));
    expect(screen.getByText(/empty\.line1/)).toBeInTheDocument();
    expect(screen.queryByText("hidden.allHidden")).toBeNull();
    expect(container.querySelector("details")).toBeNull();
  });
});

describe("CollectionStreamerList: 並び替え (#1953)", () => {
  it("3つの並び替えリンク(<a href>)を出し、現在のモードに aria-current を付ける", () => {
    renderList({}, "?sort=name");
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

  it("初期表示は URL の ?sort= の orders の順（props ではなく URL を正とする）", () => {
    const { container } = renderList({}, "?sort=name");
    expect(listed(container).visible).toEqual(["Charlie", "Bravo", "Alpha"]);
  });

  it("URL の ?sort= が無い・不正なら既定(recent)の順", () => {
    expect(listed(renderList({}, "?sort=bogus").container).visible).toEqual(["Alpha", "Bravo", "Charlie"]);
  });

  it("クリックすると fetch / router を呼ばずに並びが入れ替わり、replaceState と aria-current が移る", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const replaceState = vi.spyOn(window.history, "replaceState");
    const { container } = renderList();
    expect(listed(container).visible).toEqual(["Alpha", "Bravo", "Charlie"]);

    const name = screen.getByRole("link", { name: "sort.name" });
    // fireEvent の戻り値は preventDefault されたとき false
    expect(fireEvent.click(name)).toBe(false);

    expect(listed(container).visible).toEqual(["Charlie", "Bravo", "Alpha"]);
    expect(replaceState).toHaveBeenCalledWith(null, "", "/dashboard/collection?sort=name");
    expect(name).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("link", { name: "sort.recent" })).not.toHaveAttribute("aria-current");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.postJsonWithCsrfRetry).not.toHaveBeenCalled();
    expect(mocks.refresh).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("link", { name: "sort.completion" }));
    expect(listed(container).visible).toEqual(["Bravo", "Charlie", "Alpha"]);
    replaceState.mockRestore();
  });

  it.each([
    ["Ctrl", { ctrlKey: true }],
    ["Meta", { metaKey: true }],
    ["Shift", { shiftKey: true }],
    ["Alt", { altKey: true }],
    ["中クリック", { button: 1 }],
  ])("%s 付きクリックは preventDefault せず並びも変えない（既定動作に任せる）", (_label, init) => {
    const replaceState = vi.spyOn(window.history, "replaceState");
    const { container } = renderList();
    const name = screen.getByRole("link", { name: "sort.name" });
    // preventDefault されなければ true。jsdom の <a> 遷移は未実装だが副作用は無い
    expect(fireEvent.click(name, init)).toBe(true);
    expect(listed(container).visible).toEqual(["Alpha", "Bravo", "Charlie"]);
    expect(replaceState).not.toHaveBeenCalled();
    replaceState.mockRestore();
  });

  it("表示中が1件以下なら並び替えバーを出さない（非表示にして1件に減ったときも消える）", () => {
    const { unmount } = renderList({ items: [ITEMS[0]], orders: { ...ORDERS, recent: ["a"] } });
    expect(screen.queryByRole("link", { name: "sort.name" })).toBeNull();
    unmount();

    // 2件表示中は出る。1件を非表示にすると残り1件になり、バーが消える
    mocks.postJsonWithCsrfRetry.mockReturnValue(new Promise(() => {}));
    renderList({
      items: [ITEMS[0], ITEMS[1]],
      orders: { recent: ["a", "b"], name: ["a", "b"], completion: ["a", "b"] },
    });
    expect(screen.getByRole("link", { name: "sort.name" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: 'hideAria:{"name":"Alpha"}' }));
    expect(screen.queryByRole("link", { name: "sort.name" })).toBeNull();
  });

  it("orders に無い id のカードは末尾に置く", () => {
    const { container } = renderList({ orders: { ...ORDERS, recent: ["c", "a"] } });
    expect(listed(container).visible).toEqual(["Charlie", "Alpha", "Bravo"]);
  });
});

describe("CollectionStreamerList: 非表示セクション (#1953)", () => {
  it("非表示の配信者は <details> の中に件数つきで出し、再表示ボタンになる（直リンクも残る）", () => {
    const { container } = renderList({ initialHiddenIds: ["b", "c"] });
    const details = container.querySelector("details");
    expect(details).not.toBeNull();
    // 既定は折りたたみ
    expect(details).not.toHaveAttribute("open");
    expect(details!.querySelector("summary")!.textContent).toBe('hidden.summary:{"count":2}');
    expect(listed(container)).toEqual({ visible: ["Alpha"], hidden: ["Bravo", "Charlie"] });
    expect(details!.querySelector('a[href="/collection/b"]')).not.toBeNull();
    expect(screen.getByRole("button", { name: 'hideAria:{"name":"Alpha"}' })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: 'showAria:{"name":"Bravo"}' })).toBeInTheDocument();
  });

  it("全件非表示のときは専用メッセージ＋非表示セクションを出し、並び替えバーは出さない", () => {
    const { container } = renderList({ initialHiddenIds: ["a", "b", "c"] });
    expect(screen.getByText("hidden.allHidden")).toBeInTheDocument();
    expect(container.querySelector("details")).not.toBeNull();
    expect(screen.queryByRole("link", { name: "sort.name" })).toBeNull();
  });

  it("非表示が無ければ <details> を出さない", () => {
    const { container } = renderList();
    expect(container.querySelector("details")).toBeNull();
  });
});

describe("CollectionStreamerList: 非表示 / 再表示（楽観的更新）(#1953)", () => {
  it("非表示: POST の完了前にカードが移り、正しい引数で呼び、pending 中はボタンが disabled。成功後に裏で router.refresh する", async () => {
    let resolvePost: (v: { ok: boolean }) => void = () => {};
    mocks.postJsonWithCsrfRetry.mockReturnValue(new Promise((r) => (resolvePost = r)));
    const { container } = renderList();

    fireEvent.click(screen.getByRole("button", { name: 'hideAria:{"name":"Bravo"}' }));

    // POST は未完了だがカードは非表示セクションへ移動済み
    expect(listed(container)).toEqual({ visible: ["Alpha", "Charlie"], hidden: ["Bravo"] });
    expect(mocks.postJsonWithCsrfRetry).toHaveBeenCalledTimes(1);
    expect(mocks.postJsonWithCsrfRetry).toHaveBeenCalledWith("/api/collection/hidden-streamers", {
      streamerId: "b",
      hidden: true,
    });
    const showButton = screen.getByRole("button", { name: 'showAria:{"name":"Bravo"}' });
    expect(showButton).toBeDisabled();
    // 二重送信されない
    fireEvent.click(showButton);
    expect(mocks.postJsonWithCsrfRetry).toHaveBeenCalledTimes(1);
    // 別の配信者のボタンは操作できる
    expect(screen.getByRole("button", { name: 'hideAria:{"name":"Alpha"}' })).not.toBeDisabled();

    resolvePost({ ok: true });
    await waitFor(() => expect(showButton).not.toBeDisabled());
    expect(listed(container)).toEqual({ visible: ["Alpha", "Charlie"], hidden: ["Bravo"] });
    expect(screen.queryByRole("alert")).toBeNull();
    // 「戻る」で古い payload が復元されないよう、保存成功後にキャッシュを揃える（完了は待たない）
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });

  it("非表示が失敗(ok=false)したらカードが元の通常一覧へ戻り、そのカードに role=alert が出る", async () => {
    mocks.postJsonWithCsrfRetry.mockResolvedValue({ ok: false });
    const { container } = renderList();

    fireEvent.click(screen.getByRole("button", { name: 'hideAria:{"name":"Bravo"}' }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("error");
    expect(listed(container)).toEqual({ visible: ["Alpha", "Bravo", "Charlie"], hidden: [] });
    // エラーは失敗したカードにだけ出て、ボタンは再試行できる
    const bravoCard = screen.getByRole("heading", { name: "Bravo" }).parentElement!;
    expect(within(bravoCard).getByRole("alert")).toBe(alert);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: 'hideAria:{"name":"Bravo"}' })).not.toBeDisabled(),
    );
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("失敗後に同じカードを再操作するとエラーが消える", async () => {
    mocks.postJsonWithCsrfRetry.mockResolvedValueOnce({ ok: false });
    renderList();
    fireEvent.click(screen.getByRole("button", { name: 'hideAria:{"name":"Bravo"}' }));
    await screen.findByRole("alert");

    mocks.postJsonWithCsrfRetry.mockReturnValueOnce(new Promise(() => {}));
    fireEvent.click(await screen.findByRole("button", { name: 'hideAria:{"name":"Bravo"}' }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("再表示: hidden=false で POST し、クリック直後に通常一覧へ戻る。失敗したら非表示側へ戻る", async () => {
    let resolvePost: (v: { ok: boolean }) => void = () => {};
    mocks.postJsonWithCsrfRetry.mockReturnValueOnce(new Promise((r) => (resolvePost = r)));
    const { container } = renderList({ initialHiddenIds: ["b"] });

    fireEvent.click(screen.getByRole("button", { name: 'showAria:{"name":"Bravo"}' }));

    expect(listed(container)).toEqual({ visible: ["Alpha", "Bravo", "Charlie"], hidden: [] });
    expect(mocks.postJsonWithCsrfRetry).toHaveBeenCalledWith("/api/collection/hidden-streamers", {
      streamerId: "b",
      hidden: false,
    });

    resolvePost({ ok: false });
    expect(await screen.findByRole("alert")).toHaveTextContent("error");
    expect(listed(container)).toEqual({ visible: ["Alpha", "Charlie"], hidden: ["Bravo"] });
  });

  it("並行操作: 別の配信者の成功・失敗が互いの状態を壊さない", async () => {
    const resolvers: Record<string, (v: { ok: boolean }) => void> = {};
    mocks.postJsonWithCsrfRetry.mockImplementation(
      (_url: string, body: { streamerId: string }) =>
        new Promise((r) => (resolvers[body.streamerId] = r)),
    );
    const { container } = renderList();

    fireEvent.click(screen.getByRole("button", { name: 'hideAria:{"name":"Alpha"}' }));
    fireEvent.click(screen.getByRole("button", { name: 'hideAria:{"name":"Bravo"}' }));
    expect(listed(container)).toEqual({ visible: ["Charlie"], hidden: ["Alpha", "Bravo"] });

    resolvers.a({ ok: true });
    resolvers.b({ ok: false });
    await screen.findByRole("alert");
    // Alpha は非表示のまま、Bravo だけ戻る
    expect(listed(container)).toEqual({ visible: ["Bravo", "Charlie"], hidden: ["Alpha"] });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: 'showAria:{"name":"Alpha"}' })).not.toBeDisabled(),
    );
  });
});

describe("CollectionHideButton (表示専用) (#1953)", () => {
  it("hide=true は「非表示」、hide=false は「再表示」の文言と aria-label を出し、クリックを onClick に渡す", () => {
    const onClick = vi.fn();
    const { rerender } = render(
      <CollectionHideButton streamerName="Alpha" hide disabled={false} onClick={onClick} error={false} />,
    );
    const hideButton = screen.getByRole("button", { name: 'hideAria:{"name":"Alpha"}' });
    expect(hideButton).toHaveTextContent("hideButton");
    fireEvent.click(hideButton);
    expect(onClick).toHaveBeenCalledTimes(1);

    rerender(
      <CollectionHideButton streamerName="Alpha" hide={false} disabled={false} onClick={onClick} error={false} />,
    );
    expect(screen.getByRole("button", { name: 'showAria:{"name":"Alpha"}' })).toHaveTextContent("showButton");
  });

  it("disabled と error を props のとおりに反映する", () => {
    const { rerender } = render(
      <CollectionHideButton streamerName="Alpha" hide disabled onClick={vi.fn()} error={false} />,
    );
    expect(screen.getByRole("button")).toBeDisabled();
    expect(screen.queryByRole("alert")).toBeNull();

    rerender(<CollectionHideButton streamerName="Alpha" hide disabled={false} onClick={vi.fn()} error />);
    expect(screen.getByRole("button")).not.toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("error");
  });
});
