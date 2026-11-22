"use client";

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";

interface DashboardShellProps {
  /**
   * Navigation rendered inside the sidebar / drawer.
   * サイドバー・ドロワーの中に描画するナビゲーション。
   *
   * ReactNode として受け取るのは、呼び出し側（server layout）が
   * `<DashboardNav isStreamer ... />` をそのまま渡せるようにするため。
   * ここで DashboardNav を import すると、このコンポーネントが
   * ナビの props や権限判定まで知ることになり、レイアウト間で共有する
   * 意味がなくなる。
   */
  nav: ReactNode;
  children: ReactNode;
}

/**
 * Dashboard chrome with a responsive sidebar navigation.
 *
 * Design notes:
 * - There is exactly ONE `nav` element in the DOM. The same element is the
 *   desktop sidebar (`lg:block`) and the drawer (`fixed` when open, `hidden`
 *   when closed). Rendering one copy for desktop and another for mobile would
 *   duplicate every link, which breaks `getByRole` queries and makes screen
 *   readers announce the navigation twice.
 * - The drawer uses disclosure navigation with `aria-expanded` and
 *   `aria-controls`. Escape, backdrop clicks and the close button dismiss it
 *   and return focus to the trigger. A route change or moving focus outside
 *   also dismisses it, so Tab can reach the page without a focus trap.
 * - Route changes are observed through `usePathname` instead of the click
 *   handler alone because browser back/forward and programmatic navigation can
 *   change the route while the drawer is open.
 */
export default function DashboardShell({ nav, children }: DashboardShellProps) {
  const t = useTranslations("navigation");
  const pathname = usePathname();
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  // 同じレイアウト内に複数の shell が置かれても id が衝突しないようにする。
  // aria-controls と aside の id を同じ値にするため、ここで一度だけ生成する。
  const sidebarId = useId();

  const closeDrawer = useCallback(() => {
    setIsDrawerOpen(false);
    // 閉じた後にフォーカスが body へ落ちると、キーボード利用者は現在位置を
    // 見失う。ドロワーを開いたボタンへ戻す（disclosure パターンの標準的な
    // フォーカス管理）。DOM 上に存在する限り、非表示要素への focus() は
    // ブラウザ側で無視されるだけで例外にはならない。
    menuButtonRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!isDrawerOpen) return;

    // The panel covers the trigger on mobile. Put focus on the visible close
    // button so the next Tab goes to the first link and Shift+Tab can leave.
    closeButtonRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // 開いている間の Escape はドロワーのための操作なので、背面の
      // コンポーネントにも同じキーが届かないようにする。
      event.preventDefault();
      closeDrawer();
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [closeDrawer, isDrawerOpen]);

  // ルート遷移では必ず閉じる。リンククリック時は onClick 側でも閉じるが、
  // ブラウザの戻る/進むなどクリックを伴わない遷移も同じ状態に揃える。
  //
  // effect 内で setState すると react-hooks/set-state-in-effect に抵触し、
  // 描画後に一瞬だけ開いたドロワーが見えることもある。React が「props の変化に
  // 合わせて render 中に state を調整する」と認めているパターン（前回の
  // pathname と比較し、変わったときだけ更新する）を使い、コミット前に閉じる。
  // ここでは focus を動かさない: 遷移直後にメニューボタンへフォーカスを奪うと、
  // ページ側が遷移後に当てたフォーカスを壊すため。
  const [lastPathname, setLastPathname] = useState(pathname);
  if (lastPathname !== pathname) {
    setLastPathname(pathname);
    setIsDrawerOpen(false);
  }

  const handleSidebarClick = (event: ReactMouseEvent<HTMLElement>) => {
    // ナビ項目は DashboardNav が描画するため、shell 側から各 Link に
    // onClick を渡すことはできない。aside でクリックを委譲し、リンク遷移の
    // 開始時にドロワーを閉じる。デスクトップでは open が false なので何もしない。
    if (!isDrawerOpen) return;
    const target = event.target;
    if (target instanceof Element && target.closest("a")) closeDrawer();
  };

  return (
    // サイドバーを出すのは lg（1024px）以上にする。md（768px）から出すと、
    // 本文幅が約736pxから約488pxへ縮み、本文側の md: 段組みが「画面幅で発火した
    // まま列だけ細くなる」。例えば CardManager の md:grid-cols-8 は1枚が約81px
    // から約50pxになり、2列カードも1列約238pxから約119pxへ潰れる。
    // lg 以上なら 768〜1023px はドロワーで本文幅を従来どおり保ち、1024px でも
    // 本文は約744px（外枠内側 992px - w-56 224px - gap-6 24px）で、
    // 従来 md の段組みが発火していた幅（約736px）を下回らない。
    <div
      className="lg:flex lg:items-start lg:gap-6"
      onBlur={(event) => {
        const next = event.relatedTarget;
        // Tab may move from the last nav link to a control in the content.
        // Remove the backdrop in that case, leaving focus on the new control.
        // A null destination can be a backdrop pointer press; let its click
        // handler perform the dismissal and restore focus to the toggle.
        if (isDrawerOpen && next && !sidebarRef.current?.contains(next)) {
          setIsDrawerOpen(false);
        }
      }}
    >
      {/* lg 未満専用の開閉ボタン。lg 以上ではサイドバーが常時表示されるため隠す。 */}
      <button
        ref={menuButtonRef}
        type="button"
        aria-expanded={isDrawerOpen}
        aria-controls={sidebarId}
        aria-label={t("menu")}
        onClick={() => setIsDrawerOpen((open) => !open)}
        className="mb-3 inline-flex items-center gap-2 rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm font-medium text-gray-200 transition-colors hover:bg-gray-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-400 lg:hidden"
      >
        <svg
          className="h-5 w-5"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M4 6h16M4 12h16M4 18h16"
          />
        </svg>
        <span>{t("menu")}</span>
      </button>

      {/* 背景クリックで閉じるためのオーバーレイ。lg 以上では表示しない。 */}
      {isDrawerOpen && (
        <div
          data-testid="dashboard-shell-backdrop"
          className="fixed inset-0 z-40 bg-black/60 lg:hidden"
          aria-hidden="true"
          onClick={closeDrawer}
        />
      )}

      {/*
        ナビは1つだけ描画し、CSS でデスクトップのサイドバーと lg 未満の
        ドロワーを切り替える。閉じている lg 未満では `hidden`、lg 以上では
        `lg:block` が常に有効になるため、状態に関係なくサイドバーが見える。
        デスクトップの境界線はナビ項目の高さで途切れず、隣の本文に沿って伸ばす。
        これによりナビが本文のカードと同じ独立したパネルに見えるのを防ぐ。
      */}
      <aside
        ref={sidebarRef}
        id={sidebarId}
        data-state={isDrawerOpen ? "open" : "closed"}
        onClick={handleSidebarClick}
        className={`lg:block lg:w-56 lg:shrink-0 lg:self-stretch lg:border-r lg:border-gray-800 ${
          isDrawerOpen
            ? "fixed inset-y-0 left-0 z-50 w-72 max-w-[85vw] overflow-y-auto bg-gray-900 p-4 shadow-xl lg:static lg:z-auto lg:overflow-visible lg:bg-transparent lg:p-0 lg:shadow-none"
            : "hidden"
        }`}
      >
        {/*
          ドロワー内の閉じるボタン。オーバーレイの外側をタップできない
          スクリーンリーダー利用者にも明示的な閉じる手段を提供する。
          lg 以上ではサイドバーが常時表示なので隠す。
        */}
        <div className="mb-3 flex justify-end lg:hidden">
          <button
            ref={closeButtonRef}
            type="button"
            aria-label={t("closeMenu")}
            onClick={closeDrawer}
            className="rounded-lg p-2 text-gray-300 transition-colors hover:bg-gray-800 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-400"
          >
            <svg
              className="h-5 w-5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>

        {nav}
      </aside>

      {/* 本文。min-w-0 がないと flex 子要素の既定 min-width:auto により、
          長いコードや表がサイドバーを押し広げてしまう。 */}
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
