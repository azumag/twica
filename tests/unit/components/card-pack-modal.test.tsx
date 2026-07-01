import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import CardPackModal from "@/components/CardPackModal";
import jaMessages from "../../../messages/ja.json";

vi.mock("@/lib/logger");

// Issue #393再設計: パック管理モーダル。追加はisPremiumでゲートし、削除は
// 常に許可、保存はサーバーの実際の永続化結果でstateを同期する。

type FetchMock = ReturnType<typeof vi.fn>;

function renderModal(props: Partial<React.ComponentProps<typeof CardPackModal>> = {}) {
  const onClose = vi.fn();
  const onSaved = vi.fn();
  const utils = render(
    <NextIntlClientProvider locale="ja" messages={jaMessages}>
      <CardPackModal
        isOpen
        onClose={onClose}
        streamerId="streamer-1"
        cardPackNames={["weapons"]}
        isPremium={false}
        onSaved={onSaved}
        {...props}
      />
    </NextIntlClientProvider>
  );
  return { ...utils, onClose, onSaved };
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
      expect(screen.getByText(/支援プランまたはTwitchサブスクが必要です/)).toBeInTheDocument();
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
});
