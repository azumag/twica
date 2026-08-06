"use client";

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
}: ExpandableDescriptionProps) {
  // テキストサイズに基づくクラス
  // Classes based on text size
  const textSizeClass = size === "xs" ? "text-xs text-gray-400" : "text-sm text-gray-300";
  const tCommon = useTranslations("common");
  const [isExpanded, setIsExpanded] = useState(false);
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

  const handleClick = () => {
    // 省略されている場合のみ展開/折りたたみを切り替え
    // Only toggle if text is actually truncated
    if (isTruncated || isExpanded) {
      setIsExpanded(!isExpanded);
    }
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

  return (
    <div className="mb-1">
      <p
        ref={textRef}
        onClick={handleClick}
        style={expandedStyle}
        className={`${textSizeClass} ${lineClampClass} ${
          isClickable ? "cursor-pointer hover:text-gray-200" : ""
        }`}
      >
        {description}
      </p>
      {/* 展開インジケーター（省略時のみ表示、展開後は非表示だがクリックで折りたたみ可能） */}
      {/* Expand indicator (shown only when truncated, hidden after expand but click to collapse still works) */}
      {isTruncated && !isExpanded && (
        <button
          onClick={handleClick}
          className="text-xs text-purple-400 hover:text-purple-300 mt-1 flex items-center gap-1"
        >
          <span>▼</span>
          <span>{tCommon("expand")}</span>
        </button>
      )}
      {/* 折りたたみインジケーター（展開時のみ表示） */}
      {/* Collapse indicator (shown only when expanded) */}
      {isExpanded && (
        <button
          onClick={handleClick}
          className="text-xs text-purple-400 hover:text-purple-300 mt-1 flex items-center gap-1"
        >
          <span>▲</span>
          <span>{tCommon("collapse")}</span>
        </button>
      )}
    </div>
  );
}
