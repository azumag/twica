import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import CardPackModal from "@/components/CardPackModal";
import jaMessages from "../../../messages/ja.json";

vi.mock("@/lib/logger");

// Issue #393再設計: パック管理モーダル。追加はisPremiumでゲートし、削除は
// 常に許可、保存はサーバーの実際の永続化結果でstateを同期する。
// Issue #554: 削除不可の固定「デフォルト」行 + 両方のリネームUIを追加。

type FetchMock = ReturnType<typeof vi.fn>;

function renderModal(props: Partial<React.ComponentProps<typeof CardPackModal>> = {}) {
  const onClose = vi.fn();
  const onSaved = vi.fn();
  const onDefaultPackNameSaved = vi.fn();
  const utils = render(
    <NextIntlClientProvider locale="ja" messages={jaMessages}>
      <CardPackModal
        isOpen
        onClose={onClose}
        streamerId="streamer-1"
        cardPackNames={["weapons"]}
        defaultPackName={null}
        isPremium={false}
        onSaved={onSaved}
        onDefaultPackNameSaved={onDefaultPackNameSaved}
        {...props}
      />
    </NextIntlClientProvider>
  );
  return { ...utils, onClose, onSaved, onDefaultPackNameSaved };
}

describe("CardPackModal", () => {
  let fetchMock: FetchMock;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders existing pack names", () => {
    renderModal();
    expect(screen.getByText("weapons")).toBeInTheDocument();
  });

  it("disables the add input/button when isPremium is false", () => {
    renderModal({ isPremium: false });
    expect(screen.getByPlaceholderText("新しいパック名")).toBeDisabled();
    expect(screen.getByRole("button", { name: "追加" })).toBeDisabled();
  });

  it("enables the add input/button when isPremium is true", () => {
    renderModal({ isPremium: true });
    expect(screen.getByPlaceholderText("新しいパック名")).not.toBeDisabled();
    expect(screen.getByRole("button", { name: "追加" })).not.toBeDisabled();
  });

  it("allows removing an existing pack even when isPremium is false", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ success: true, cardPackNames: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    const { onSaved, onClose } = renderModal({ isPremium: false, cardPackNames: ["weapons"] });

    fireEvent.click(screen.getByLabelText("Remove weapons"));
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/streamer/settings",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ streamerId: "streamer-1", cardPackNames: [] }),
        })
      );
    });
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith([]));
    expect(onClose).toHaveBeenCalled();
  });

  // Issue #555: `__`-prefixed names are reserved for sentinel values like
  // DEFAULT_PACK_SENTINEL and must be rejected client-side (in addition to the
  // server-side validateCardPackNamesInput check) so streamers get immediate
  // feedback instead of a failed save.
  it("rejects a `__`-prefixed (reserved) pack name and does not add it", async () => {
    renderModal({ isPremium: true, cardPackNames: ["weapons"] });

    fireEvent.change(screen.getByPlaceholderText("新しいパック名"), {
      target: { value: "__default__" },
    });
    fireEvent.click(screen.getByRole("button", { name: "追加" }));

    expect(screen.getByText("__ で始まる名前は予約されているため使用できません")).toBeInTheDocument();
    expect(screen.queryByText("__default__")).not.toBeInTheDocument();
  });

  it("adds a new pack name and saves when isPremium is true", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ success: true, cardPackNames: ["weapons", "characters"] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    const { onSaved, onClose } = renderModal({ isPremium: true, cardPackNames: ["weapons"] });

    fireEvent.change(screen.getByPlaceholderText("新しいパック名"), {
      target: { value: "characters" },
    });
    fireEvent.click(screen.getByRole("button", { name: "追加" }));
    expect(screen.getByText("characters")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(["weapons", "characters"]));
    expect(onClose).toHaveBeenCalled();
  });

  it("does NOT close and shows a notice when the server drops a gated addition", async () => {
    // Server rejected the new addition (basic plan) — persisted list excludes it.
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          cardPackNames: ["weapons"],
          cardPackNamesPremiumRequired: true,
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    // Simulate a stale isPremium=true client state that raced with a downgrade
    // server-side, so the "add" UI was enabled but the server still gated it.
    const { onSaved, onClose } = renderModal({ isPremium: true, cardPackNames: ["weapons"] });

    fireEvent.change(screen.getByPlaceholderText("新しいパック名"), {
      target: { value: "armor" },
    });
    fireEvent.click(screen.getByRole("button", { name: "追加" }));
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => {
      expect(screen.getByText(/おまけ機能として提供されています/)).toBeInTheDocument();
    });
    expect(onSaved).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  // 自己レビューで発見した重大バグの回帰テスト: サーバーが
  // cardPackNamesSkippedDeployWindow を返した場合(書き込み自体が
  // デプロイ窓で見送られ、実際には未保存)、成功扱いでモーダルを閉じては
  // ならない(次回読み込み時に静かに消えたように見えるため)。
  it("does NOT close and shows a deploy-window notice when the write itself was skipped", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          cardPackNames: ["weapons"],
          cardPackNamesSkippedDeployWindow: true,
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    const { onSaved, onClose } = renderModal({ isPremium: true, cardPackNames: ["weapons"] });

    fireEvent.change(screen.getByPlaceholderText("新しいパック名"), {
      target: { value: "armor" },
    });
    fireEvent.click(screen.getByRole("button", { name: "追加" }));
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => {
      expect(screen.getByText(/パック機能が準備中/)).toBeInTheDocument();
    });
    expect(onSaved).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("shows an error and does not call onSaved when the save request fails", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "失敗しました" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      })
    );
    const { onSaved, onClose } = renderModal({ isPremium: true, cardPackNames: ["weapons"] });

    fireEvent.change(screen.getByPlaceholderText("新しいパック名"), {
      target: { value: "characters" },
    });
    fireEvent.click(screen.getByRole("button", { name: "追加" }));
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => {
      expect(screen.getByText("失敗しました")).toBeInTheDocument();
    });
    expect(onSaved).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  // Issue #554: 固定「デフォルト」行
  describe("default pack row", () => {
    it("shows the generic label and no remove button when defaultPackName is unset", () => {
      renderModal({ defaultPackName: null });
      expect(screen.getByText("デフォルト")).toBeInTheDocument();
      expect(screen.getByText("削除不可")).toBeInTheDocument();
      expect(screen.queryByLabelText("Remove デフォルト")).not.toBeInTheDocument();
    });

    it("shows the custom display name when defaultPackName is set", () => {
      renderModal({ defaultPackName: "オリジナルカード" });
      expect(screen.getByText("オリジナルカード")).toBeInTheDocument();
      expect(screen.queryByText("デフォルト")).not.toBeInTheDocument();
    });
  });

  // Issue #554: 未保存の追加/削除がある間はリネーム不可
  describe("rename disabled while there are unsaved add/remove changes", () => {
    it("disables the rename trigger buttons and shows a hint once a pack is added", () => {
      renderModal({ isPremium: true, cardPackNames: ["weapons"] });

      fireEvent.change(screen.getByPlaceholderText("新しいパック名"), {
        target: { value: "characters" },
      });
      fireEvent.click(screen.getByRole("button", { name: "追加" }));

      expect(screen.getByLabelText("Rename weapons")).toBeDisabled();
      expect(screen.getByLabelText("Rename default pack")).toBeDisabled();
      expect(
        screen.getByText("未保存の変更があるため、リネームするには先に保存してください")
      ).toBeInTheDocument();
    });
  });

  // Issue #554: 通常パックのリネーム — PATCH /api/cards/collections を即時呼ぶ
  describe("renaming an existing pack", () => {
    it("PATCHes /api/cards/collections and syncs local state + onSaved on success", async () => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ success: true, cardPackNames: ["armory"] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      );
      const { onSaved } = renderModal({ cardPackNames: ["weapons"] });

      const renameTrigger = screen.getByLabelText("Rename weapons");
      const row = renameTrigger.closest("li")!;
      fireEvent.click(renameTrigger);
      fireEvent.change(within(row).getByRole("textbox"), { target: { value: "armory" } });
      fireEvent.click(within(row).getByRole("button", { name: "保存" }));

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          "/api/cards/collections",
          expect.objectContaining({
            method: "PATCH",
            body: JSON.stringify({ streamerId: "streamer-1", oldName: "weapons", newName: "armory" }),
          })
        );
      });
      await waitFor(() => expect(onSaved).toHaveBeenCalledWith(["armory"]));
      expect(screen.getByText("armory")).toBeInTheDocument();
      expect(screen.queryByText("weapons")).not.toBeInTheDocument();
    });

    it("shows a server-returned error and keeps editing on failure", async () => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ error: "既に登録されています" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        })
      );
      renderModal({ cardPackNames: ["weapons"] });

      const renameTrigger = screen.getByLabelText("Rename weapons");
      const row = renameTrigger.closest("li")!;
      fireEvent.click(renameTrigger);
      fireEvent.change(within(row).getByRole("textbox"), { target: { value: "characters" } });
      fireEvent.click(within(row).getByRole("button", { name: "保存" }));

      await waitFor(() => {
        expect(within(row).getByText("既に登録されています")).toBeInTheDocument();
      });
      // Stays in edit mode (input still holds the attempted value) rather than
      // silently reverting or closing — the streamer can correct and retry.
      expect(within(row).getByDisplayValue("characters")).toBeInTheDocument();
    });

    // Issue #554 レビュー指摘: デフォルトパックの表示名と同名へのリネームは
    // クライアント側で拒否する(select上に同一ラベルの選択肢が2つ並ぶのを防ぐ。
    // 逆方向 — デフォルト表示名→実パック名 — のチェックと対称)。
    it("rejects renaming a pack to the current default-pack display name without calling the API", async () => {
      renderModal({ cardPackNames: ["weapons"], defaultPackName: "オリジナルカード" });

      const renameTrigger = screen.getByLabelText("Rename weapons");
      const row = renameTrigger.closest("li")!;
      fireEvent.click(renameTrigger);
      fireEvent.change(within(row).getByRole("textbox"), { target: { value: "オリジナルカード" } });
      fireEvent.click(within(row).getByRole("button", { name: "保存" }));

      expect(within(row).getByText("同じパック名が既に存在します")).toBeInTheDocument();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  // Issue #554: デフォルトパックのリネーム — POST /api/streamer/settings を即時呼ぶ
  describe("renaming the default pack", () => {
    it("POSTs defaultCardPackName and syncs local state + onDefaultPackNameSaved on success", async () => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      );
      const { onDefaultPackNameSaved } = renderModal({ defaultPackName: null });

      const renameTrigger = screen.getByLabelText("Rename default pack");
      const row = renameTrigger.closest("li")!;
      fireEvent.click(renameTrigger);
      fireEvent.change(within(row).getByRole("textbox"), { target: { value: "オリジナルカード" } });
      fireEvent.click(within(row).getByRole("button", { name: "保存" }));

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          "/api/streamer/settings",
          expect.objectContaining({
            method: "POST",
            body: JSON.stringify({ streamerId: "streamer-1", defaultCardPackName: "オリジナルカード" }),
          })
        );
      });
      await waitFor(() => expect(onDefaultPackNameSaved).toHaveBeenCalledWith("オリジナルカード"));
      expect(screen.getByText("オリジナルカード")).toBeInTheDocument();
    });

    it("treats a blank input as a reset to null", async () => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      );
      const { onDefaultPackNameSaved } = renderModal({ defaultPackName: "オリジナルカード" });

      const renameTrigger = screen.getByLabelText("Rename default pack");
      const row = renameTrigger.closest("li")!;
      fireEvent.click(renameTrigger);
      fireEvent.change(within(row).getByRole("textbox"), { target: { value: "   " } });
      fireEvent.click(within(row).getByRole("button", { name: "保存" }));

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          "/api/streamer/settings",
          expect.objectContaining({
            body: JSON.stringify({ streamerId: "streamer-1", defaultCardPackName: null }),
          })
        );
      });
      await waitFor(() => expect(onDefaultPackNameSaved).toHaveBeenCalledWith(null));
    });
  });
});
