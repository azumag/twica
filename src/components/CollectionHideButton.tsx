"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { postTradeJson } from "@/lib/trade-client";

interface CollectionHideButtonProps {
  streamerId: string;
  /** aria-label 用の配信者表示名（同じ文言のボタンが並ぶため、対象を読み上げに含める） */
  streamerName: string;
  /**
   * このボタンを押した結果の状態。true = 非表示にする（通常カード側のボタン）、
   * false = 再表示する（「非表示のコレクション」内のボタン）。
   */
  hide: boolean;
}

/**
 * マイコレクション一覧の「非表示 / 再表示」ボタン (#1953)。
 *
 * - サーバーコンポーネントの一覧(Collection)から、クリック操作が必要なこの部品だけを
 *   client component に切り出している（一覧全体を client 化しない）。
 * - 書き込みは postTradeJson を再利用する。このヘルパーは名前こそトレード由来だが、
 *   CSRF cookie が未発行（HttpOnly + 遅延発行、src/lib/csrf.ts）のときの
 *   403 CSRF_TOKEN_INVALID → GET /api/session → 1回だけ再送、という本リポジトリ共通の
 *   復旧手順と、メンテナンス応答の解釈を実装済みで、トレード固有の処理は含まない。
 *   同じ手順をここで再実装して食い違わせないために使う。
 * - 確認ダイアログは出さない。非表示はカード所持に影響せず、「非表示のコレクション」
 *   から 1 クリックで元に戻せる可逆な操作のため、確認で操作を重くしない。
 * - 成功後は router.refresh() でサーバー側の一覧（並び・件数・折りたたみ）を再取得する。
 *   送信中と再取得中は disabled にして二重送信を防ぐ（API 自体も冪等）。
 */
export default function CollectionHideButton({
  streamerId,
  streamerName,
  hide,
}: CollectionHideButtonProps) {
  const t = useTranslations("collection.hide");
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(false);
  // router.refresh() の完了まで isRefreshing が true になり、再取得中の再クリックも防ぐ
  const [isRefreshing, startTransition] = useTransition();

  const handleClick = async () => {
    setSubmitting(true);
    setError(false);
    try {
      const result = await postTradeJson("/api/collection/hidden-streamers", {
        streamerId,
        hidden: hide,
      });
      if (result.ok) {
        startTransition(() => router.refresh());
      } else {
        setError(true);
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex flex-col items-end">
      <button
        type="button"
        onClick={handleClick}
        disabled={submitting || isRefreshing}
        aria-label={hide ? t("hideAria", { name: streamerName }) : t("showAria", { name: streamerName })}
        className="rounded-lg border border-gray-600 px-3 py-2 text-sm text-gray-300 transition-colors hover:bg-gray-600 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {hide ? t("hideButton") : t("showButton")}
      </button>
      {error && (
        <p role="alert" className="mt-1 max-w-[12rem] text-right text-xs text-red-400">
          {t("error")}
        </p>
      )}
    </div>
  );
}
