"use client";

import { useState } from "react";
import { logger } from "@/lib/logger";

interface CopyButtonProps {
  text: string;
}

export default function CopyButton({ text }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      } catch {
        logger.error("Failed to copy");
      }
  };

  return (
    <button
      onClick={handleCopy}
      className="rounded-lg bg-purple-600 px-4 py-2 text-white hover:bg-purple-700"
    >
      {copied ? "コピーしました" : "コピー"}
    </button>
  );
}
