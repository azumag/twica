import React from "react";

interface AutoLinkTextProps {
  text: string;
  className?: string;
}

const URL_SPLIT_REGEX = /(https?:\/\/[^\s<>"']+)/g;
const URL_TEST_REGEX = /^https?:\/\/[^\s<>"']+$/;
const TRAILING_PUNCTUATION_REGEX = /[),.!?;:]+$/;

/**
 * Converts plain URLs in text into clickable links.
 * プレーンテキスト中のURLを自動的にリンク化する。
 */
export default function AutoLinkText({ text, className }: AutoLinkTextProps) {
  const parts = text.split(URL_SPLIT_REGEX);

  return (
    <p className={className}>
      {parts.map((part, index) => {
        if (!URL_TEST_REGEX.test(part)) {
          return <React.Fragment key={index}>{part}</React.Fragment>;
        }

        const trailing = part.match(TRAILING_PUNCTUATION_REGEX)?.[0] ?? "";
        const href = trailing ? part.slice(0, -trailing.length) : part;

        return (
          <React.Fragment key={index}>
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-2 break-all hover:opacity-80"
            >
              {href}
            </a>
            {trailing}
          </React.Fragment>
        );
      })}
    </p>
  );
}
