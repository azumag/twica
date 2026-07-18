"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { parseMaintenanceError } from "@/lib/maintenance/client";
import { useMaintenanceStatus } from "./MaintenanceStatusProvider";

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
  const tMaintenance = useTranslations("maintenance");
  const router = useRouter();
  const [deleting, setDeleting] = useState(false);
  // #694 Stage 6c: ダッシュボード共有Context経由のmaintenance状態。
  // 削除のたびに個別fetchしない設計（MaintenanceStatusProvider参照）。
  const { mode: maintenanceMode } = useMaintenanceStatus();
  const isMaintenanceBlocked = maintenanceMode !== "off";

  const handleDelete = async (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();

    if (deleting || !confirm(t("messages.deleteConfirm"))) return;

    // ボタン自体はdisableしているが、CardManager.handleSubmitと同じ方針で
    // 送信経路の先頭でも二重にガードする。
    if (isMaintenanceBlocked) {
      alert(tMaintenance("writeDisabled"));
      return;
    }

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
        // maintenance mode による503拒否ならサーバーの案内文言を優先する
        // （事前disableをすり抜けた場合のフォールバック表示）。
        const maintenanceError = parseMaintenanceError(res, data);
        alert(maintenanceError?.message || data.error || t("messages.deleteFailed"));
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
      disabled={deleting || isMaintenanceBlocked}
      title={isMaintenanceBlocked ? tMaintenance("writeDisabled") : undefined}
      className={`inline-flex items-center justify-center rounded-md border border-red-500/40 px-3 py-1.5 text-sm font-medium text-red-300 transition-colors hover:border-red-400 hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-60 ${className}`}
    >
      {deleting ? t("messages.deleting") : t("messages.delete")}
    </button>
  );
}
