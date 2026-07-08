"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

interface DeleteInquiryButtonProps {
  inquiryId: string;
  redirectToList?: boolean;
  className?: string;
}

/**
 * 問い合わせ削除ボタン。
 * DELETE は破壊的操作なので、送信前確認・CSRF Cookie の遅延発行リトライ・
 * 連打防止をここに閉じ込め、一覧/詳細の両方で同じ安全な手順を使う。
 */
export default function DeleteInquiryButton({
  inquiryId,
  redirectToList = false,
  className = "",
}: DeleteInquiryButtonProps) {
  const t = useTranslations("inquiriesPage");
  const router = useRouter();
  const [deleting, setDeleting] = useState(false);

  const handleDelete = async (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();

    if (deleting || !confirm(t("messages.deleteConfirm"))) return;

    setDeleting(true);
    try {
      const requestDelete = () =>
        fetch(`/api/support-inquiries/${inquiryId}`, {
          method: "DELETE",
          credentials: "include",
        });

      let res = await requestDelete();
      if (res.status === 403) {
        const refresh = await fetch("/api/session", {
          credentials: "include",
          cache: "no-store",
        });
        if (refresh.ok) {
          res = await requestDelete();
        }
      }

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        alert(data.error || t("messages.deleteFailed"));
        return;
      }

      if (redirectToList) {
        router.push("/dashboard/inquiries");
      }
      router.refresh();
    } catch {
      alert(t("messages.networkError"));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <button
      type="button"
      onClick={handleDelete}
      disabled={deleting}
      className={`inline-flex items-center justify-center rounded-md border border-red-500/40 px-3 py-1.5 text-sm font-medium text-red-300 transition-colors hover:border-red-400 hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-60 ${className}`}
    >
      {deleting ? t("messages.deleting") : t("messages.delete")}
    </button>
  );
}
