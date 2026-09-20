import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getSession } from "@/lib/session";
import { getUserPlan } from "@/lib/plan";
import { getInquiryWithMessages } from "@/lib/support-inquiries";
import InquiryThread from "@/components/InquiryThread";
import DeleteInquiryButton from "@/components/DeleteInquiryButton";

/**
 * 問い合わせ詳細ページ
 * 問い合わせ本体 + メッセージスレッド + 返信フォーム
 */
export default async function InquiryDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const t = await getTranslations("inquiriesPage");
  const session = await getSession();

  if (!session) return null;

  // 支援者プランチェック
  const plan = await getUserPlan(session.twitchUserId);
  if (plan === "basic") {
    return (
      <div className="text-center py-12">
        <p className="text-gray-400">{t("supporterOnly")}</p>
      </div>
    );
  }

  const result = await getInquiryWithMessages(id, session.twitchUserId);
  if (!result) {
    notFound();
  }

  const { inquiry, messages } = result;

  // ステータスに対応する色
  const statusColors: Record<string, string> = {
    open: "bg-yellow-500/20 text-yellow-400",
    in_progress: "bg-blue-500/20 text-blue-400",
    resolved: "bg-green-500/20 text-green-400",
    closed: "bg-gray-500/20 text-gray-400",
  };

  const categoryLabels: Record<string, 'form.categoryBug' | 'form.categoryFeature' | 'form.categoryOther'> = {
    bug: "form.categoryBug",
    feature: "form.categoryFeature",
    other: "form.categoryOther",
  };

  return (
    <div>
      {/* 戻るリンク */}
      <Link
        href="/dashboard/inquiries"
        className="mb-4 inline-flex items-center gap-1 text-sm text-gray-400 hover:text-white"
      >
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
        </svg>
        {t("detail.backToList")}
      </Link>

      {/* 問い合わせヘッダー */}
      <div className="mb-6 rounded-xl bg-gray-800 border border-gray-700 p-6">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full bg-gray-600 px-2 py-0.5 text-xs font-medium text-gray-300">
              {t(categoryLabels[inquiry.category] || "form.categoryOther")}
            </span>
            <span
              className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                statusColors[inquiry.status] || ""
              }`}
            >
              {t(`list.status.${inquiry.status}` as 'list.status.open' | 'list.status.in_progress' | 'list.status.resolved' | 'list.status.closed')}
            </span>
            <span className="text-xs text-gray-500">
              {new Date(inquiry.created_at).toLocaleString()}
            </span>
          </div>
          <DeleteInquiryButton inquiryId={inquiry.id} redirectToList />
        </div>
        <h1 className="text-xl font-bold text-white">{inquiry.subject}</h1>
      </div>

      {/* スレッド */}
      <InquiryThread
        inquiryId={inquiry.id}
        status={inquiry.status}
        initialBody={inquiry.body}
        createdAt={inquiry.created_at}
        messages={messages}
      />
    </div>
  );
}
