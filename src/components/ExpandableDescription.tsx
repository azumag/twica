"use client";

import { useState, useRef, useEffect } from "react";

interface ExpandableDescriptionProps {
  description: string;
  /** 折りたたみ時の最大行数（デフォルト: 2） */
  maxLines?: number;
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
}: ExpandableDescriptionProps) {
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

  return (
    <div className="mb-1">
      <p
        ref={textRef}
        onClick={handleClick}
        className={`text-sm text-gray-300 ${lineClampClass} ${
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
          <span>開く</span>
        </button>
      )}
    </div>
  );
}
