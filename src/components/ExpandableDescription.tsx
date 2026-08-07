"use client";

import Link from "next/link";
import { useState, useRef, useEffect } from "react";
import { useTranslations } from "next-intl";

interface ExpandableDescriptionProps {
  description: string;
  /** 折りたたみ時の最大行数（デフォルト: 2） */
  maxLines?: number;
  /** テキストのサイズ: 'sm' (default) or 'xs' */
  size?: "sm" | "xs";
  /** 展開時の最大高さをピクセルで指定（デフォルト: 無制限） */
  /** Max height in pixels when expanded (default: unlimited) */
  maxExpandedHeight?: number;
  /** 詳細ページへのリンク（説明本文だけをリンクにする場合に指定） */
  /** Optional detail URL for the description text only. */
  detailHref?: string;
}

/**
 * 展開可能な説明テキストコンポーネント
 * デフォルトで指定行数に省略し、クリックで全文表示
 * 省略時は「▼ もっと見る」、展開時は「▲ 閉じる」を表示
 * Expandable description text component
 * Truncates to specified lines by default, expands on click
 * Shows "▼ more" when truncated, "▲ close" when expanded
 */
export default function ExpandableDescription({
  description,
  maxLines = 2,
  size = "sm",
  maxExpandedHeight,
  detailHref,
}: ExpandableDescriptionProps) {
  // テキストサイズに基づくクラス
  // Classes based on text size
  const textSizeClass = size === "xs" ? "text-xs text-gray-400" : "text-sm text-gray-300";
  const tCommon = useTranslations("common");
  const [previousDescription, setPreviousDescription] = useState(description);
  const [isExpanded, setIsExpanded] = useState(false);

  // Reactのrender中に直前のpropとの差し替えを同期する。A→B→Aのように
  // 文字列が再利用されても、直前の説明から変わるたびに展開状態を破棄する。
  // Synchronize against the immediately previous prop during render so an A→B→A
  // sequence cannot resurrect A's old expansion state.
  if (previousDescription !== description) {
    setPreviousDescription(description);
    setIsExpanded(false);
  }

  const [isTruncated, setIsTruncated] = useState(false);
  const textRef = useRef<HTMLParagraphElement>(null);

  // テキストが省略されているかどうかを検出
  // Detect if text is actually truncated
  useEffect(() => {
    const element = textRef.current;
    if (element) {
      // scrollHeightがclientHeightより大きい場合、テキストは省略されている
      // If scrollHeight > clientHeight, text is truncated
      setIsTruncated(element.scrollHeight > element.clientHeight);
    }
  }, [description]);

  useEffect(() => {
    const element = textRef.current;
    if (!element || typeof ResizeObserver === "undefined") {
      return;
    }

    // レイアウト変更を購読し、表示中の「開く」ボタンを実際の省略状態と同期する。
    // 展開中はline-clampを外しているため、observerからの実寸が非省略でもtrueを維持する。
    // Observe layout changes so the expand control matches actual truncation; while
    // expanded, preserve the flag because the clamp is intentionally removed.
    const observer = new ResizeObserver(() => {
      if (isExpanded) {
        setIsTruncated(true);
        return;
      }
      setIsTruncated(element.scrollHeight > element.clientHeight);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [description, isExpanded]);

  const handleClick = (e: React.MouseEvent) => {
    // ResizeObserverに加えて操作時点でも実寸を再確認する。通知前に古い状態が残っても、
    // 全文が収まる場合は通常遷移を維持し、新たに省略された場合はその場で展開できる。
    // Re-check the current layout at interaction time as a fallback before a
    // ResizeObserver notification so stale state cannot block or miss navigation.
    const element = textRef.current;
    const currentlyTruncated = element
      ? element.scrollHeight > element.clientHeight
      : isTruncated;
    const isExpansionControl = e.currentTarget.tagName === "BUTTON";

    // 省略された説明の開閉だけをカード内の操作として扱う。preventDefaultは
    // 親Linkの既定遷移を止め、stopPropagationは親のonClickを止める。
    // Only an actually truncated description is interactive. preventDefault stops
    // enclosing-link navigation and stopPropagation prevents its parent onClick.
    if (!currentlyTruncated && !isExpanded) {
      // 通知前に残った古いbuttonは、ラベルに反して詳細へ遷移させず次描画で除去する。
      // A stale button is canceled rather than navigating against its label.
      setIsTruncated(false);
      if (isExpansionControl) {
        e.preventDefault();
        e.stopPropagation();
      }
      return;
    }

    e.preventDefault();
    e.stopPropagation();
    setIsTruncated(true);
    setIsExpanded(!isExpanded);
  };

  // line-clampのクラス名を動的に生成
  // Dynamically generate line-clamp class
  const lineClampClass = isExpanded ? "" : `line-clamp-${maxLines}`;

  // クリック可能かどうか（省略されているか展開済み）
  // Whether clickable (truncated or already expanded)
  const isClickable = isTruncated || isExpanded;

  // 展開時に最大高さが指定されている場合のスタイル
  // Style for expanded state with max height limit
  const expandedStyle = isExpanded && maxExpandedHeight
    ? { maxHeight: `${maxExpandedHeight}px`, overflowY: "auto" as const }
    : undefined;

  const descriptionContent = (
    <p
      ref={textRef}
      // detailHrefを指定した説明は入力手段によらず詳細リンクとして動作させ、
      // 展開・折りたたみは専用buttonだけに限定する。
      // Keep linked descriptions navigable by mouse and keyboard alike; the
      // disclosure button is the only control that changes expansion state.
      onClick={detailHref ? undefined : handleClick}
      style={expandedStyle}
      className={[textSizeClass, lineClampClass, isClickable ? "cursor-pointer hover:text-gray-200" : ""].join(" ")}
    >
      {description}
    </p>
  );

  return (
    <div className="mb-1">
      {detailHref ? (
        <Link href={detailHref} className="block" prefetch={false}>
          {descriptionContent}
        </Link>
      ) : (
        descriptionContent
      )}
      {/* 開閉操作子は単一要素にして、展開状態を支援技術へ通知しフォーカスを維持する。 */}
      {/* Keep one persistent control so focus survives toggles and assistive tech sees state. */}
      {isTruncated && (
        <button
          type="button"
          aria-expanded={isExpanded}
          onClick={handleClick}
          className="text-xs text-purple-400 hover:text-purple-300 mt-1 flex items-center gap-1"
        >
          <span aria-hidden="true">{isExpanded ? "▲" : "▼"}</span>
          <span>{tCommon(isExpanded ? "collapse" : "expand")}</span>
        </button>
      )}
    </div>
  );
}
