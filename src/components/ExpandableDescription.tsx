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
 * Expandable description text component
 * Truncates to specified lines by default, expands on click
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

  return (
    <p
      ref={textRef}
      onClick={handleClick}
      className={`text-sm text-gray-300 mb-1 ${lineClampClass} ${
        isTruncated || isExpanded ? "cursor-pointer hover:text-gray-200" : ""
      }`}
      title={isTruncated && !isExpanded ? "クリックして全文を表示" : undefined}
    >
      {description}
    </p>
  );
}
