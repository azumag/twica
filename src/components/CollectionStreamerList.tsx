"use client";

import { useMemo, useState, type MouseEvent, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import CollectionHideButton from "@/components/CollectionHideButton";
import { postJsonWithCsrfRetry } from "@/lib/collection-client";
import type { StreamerCollectionSortMode } from "@/lib/collection-utils";

/** サーバー側(Collection)で描画済みの配信者カード1件分。 */
export interface CollectionStreamerItem {
  id: string;
  /** ヘッダーとレアリティサマリ */
  body: ReactNode;
  /** 「コレクションを見る」リンク */
  viewLink: ReactNode;
  /** 非表示ボタンの aria-label 用 */
  streamerName: string;
}

interface CollectionStreamerListProps {
  items: CollectionStreamerItem[];
  /** モードごとの並び（配信者ID配列）。比較ロジックは client に複製せず、サーバーで確定したものを使う。 */
  orders: Record<StreamerCollectionSortMode, string[]>;
  initialSort: StreamerCollectionSortMode;
  initialHiddenIds: string[];
}

/** 並び替えモード切替リンク。既定(recent)は URL を汚さないようクエリ無しにする。 */
const SORT_OPTIONS: ReadonlyArray<{ mode: StreamerCollectionSortMode; href: string }> = [
  { mode: "recent", href: "/dashboard/collection" },
  { mode: "name", href: "/dashboard/collection?sort=name" },
  { mode: "completion", href: "/dashboard/collection?sort=completion" },
];

/** Set を直接変更せず、id を足した / 除いた新しい Set を返す（関数型 setState 用）。 */
function withId(set: ReadonlySet<string>, id: string, present: boolean): Set<string> {
  const next = new Set(set);
  if (present) next.add(id);
  else next.delete(id);
  return next;
}

/**
 * マイコレクション一覧の配信者カード群 (#1953)。並び替えと非表示 / 再表示をブラウザ内で即時に反映する。
 *
 * なぜ client 側で行うか: 以前は並び替え(?sort= の Link 遷移)も非表示(POST 後の router.refresh())も
 * 操作のたびにサーバーで画面全体を作り直しており、リクエストが米国 colo で処理されて
 * DB(ソウル)との往復も重なり、本番実測で 2.2〜2.8 秒かかっていた。一覧のデータは
 * すべて画面上にあるので、ブラウザ側で並べ替え・移動する。
 *
 * - 並び替え: 並び順の ID 配列(orders)はサーバーで確定済み。通常クリックでは state を切り替え、
 *   URL だけ history.replaceState で更新する（共有・再読み込みで同じ並びになる）。
 *   修飾キー付き・中クリックは <a href> の既定動作（新規タブ等）に任せる。
 * - 非表示 / 再表示: 楽観的更新。クリック時点でカードを移動し、裏で POST する。失敗したら元に戻して
 *   そのカードにエラーを出す。router.refresh() は呼ばない（画面全体の再取得で 2 秒以上かかるため）。
 *   送信中のカードだけボタンを disabled にして二重送信を防ぎ、他の配信者は並行して操作できる
 *   （API 自体も冪等）。そのため state の更新は必ず関数型 setState で行い、並行操作で互いを壊さない。
 */
export default function CollectionStreamerList({
  items,
  orders,
  initialSort,
  initialHiddenIds,
}: CollectionStreamerListProps) {
  const t = useTranslations("collection");
  const [sortMode, setSortMode] = useState(initialSort);
  const [hiddenIds, setHiddenIds] = useState<ReadonlySet<string>>(() => new Set(initialHiddenIds));
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(() => new Set());
  const [errorIds, setErrorIds] = useState<ReadonlySet<string>>(() => new Set());

  // orders[sortMode] の順に並べる。orders に無い id は末尾に置く（防御。通常は起きない）。
  const orderedItems = useMemo(() => {
    const byId = new Map(items.map((item) => [item.id, item]));
    const ordered: CollectionStreamerItem[] = [];
    for (const id of orders[sortMode] ?? []) {
      const item = byId.get(id);
      if (item) {
        ordered.push(item);
        byId.delete(id);
      }
    }
    return [...ordered, ...byId.values()];
  }, [items, orders, sortMode]);

  const visibleItems = orderedItems.filter((item) => !hiddenIds.has(item.id));
  const hiddenItems = orderedItems.filter((item) => hiddenIds.has(item.id));

  const handleSortClick = (
    event: MouseEvent<HTMLAnchorElement>,
    mode: StreamerCollectionSortMode,
    href: string,
  ) => {
    // 修飾キー付き・中クリック等は既定動作（新規タブで開くなど）に任せる
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }
    event.preventDefault();
    setSortMode(mode);
    // Next.js は native history API と統合されているので、URL だけを更新してもルーターと整合する
    window.history.replaceState(null, "", href);
  };

  const toggleHidden = async (id: string, nextHidden: boolean) => {
    setErrorIds((prev) => withId(prev, id, false));
    setPendingIds((prev) => withId(prev, id, true));
    setHiddenIds((prev) => withId(prev, id, nextHidden));
    try {
      const result = await postJsonWithCsrfRetry("/api/collection/hidden-streamers", {
        streamerId: id,
        hidden: nextHidden,
      });
      if (!result.ok) {
        // 失敗: カードを元の側へ戻し、そのカードにだけエラーを出す
        setHiddenIds((prev) => withId(prev, id, !nextHidden));
        setErrorIds((prev) => withId(prev, id, true));
      }
    } finally {
      setPendingIds((prev) => withId(prev, id, false));
    }
  };

  const renderCard = (item: CollectionStreamerItem, hidden: boolean) => (
    <div
      key={item.id}
      className="rounded-xl bg-gray-800 p-4 hover:bg-gray-700 transition-colors"
    >
      {item.body}
      <div className="flex items-start gap-2">
        {item.viewLink}
        <CollectionHideButton
          streamerName={item.streamerName}
          hide={!hidden}
          disabled={pendingIds.has(item.id)}
          onClick={() => void toggleHidden(item.id, !hidden)}
          error={errorIds.has(item.id)}
        />
      </div>
    </div>
  );

  return (
    <>
      {/* 並び替え。1件以下では並び替える意味が無いので出さない。 */}
      {visibleItems.length > 1 && (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <span className="text-sm text-gray-400">{t("sort.label")}</span>
          {SORT_OPTIONS.map(({ mode, href }) => (
            // 通常の <a>: JS 無し・修飾キー付きでは href への通常遷移（サーバー再描画）にフォールバックする
            <a
              key={mode}
              href={href}
              onClick={(event) => handleSortClick(event, mode, href)}
              aria-current={sortMode === mode ? "true" : undefined}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                sortMode === mode
                  ? "bg-purple-600 text-white"
                  : "border border-gray-600 text-gray-300 hover:bg-gray-700"
              }`}
            >
              {t(`sort.${mode}`)}
            </a>
          ))}
        </div>
      )}

      {visibleItems.length === 0 ? (
        // 全件を非表示にした状態。「カードが無い」空状態とは別の文言にして、
        // 下の「非表示のコレクション」から戻せることが分かるようにする。
        <div className="rounded-xl bg-gray-800 p-8 text-center">
          <p className="text-gray-400">{t("hidden.allHidden")}</p>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {visibleItems.map((item) => renderCard(item, false))}
        </div>
      )}

      {/* #1953: 非表示のコレクション。既定は折りたたみ（<details>）。 */}
      {hiddenItems.length > 0 && (
        <details className="mt-8 rounded-xl border border-gray-700 p-4">
          <summary className="cursor-pointer text-sm font-medium text-gray-300">
            {t("hidden.summary", { count: hiddenItems.length })}
          </summary>
          <p className="mt-2 mb-4 text-xs text-gray-500">{t("hidden.description")}</p>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {hiddenItems.map((item) => renderCard(item, true))}
          </div>
        </details>
      )}
    </>
  );
}
