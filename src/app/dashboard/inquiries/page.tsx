import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { getSession } from "@/lib/session";
import { getUserPlan } from "@/lib/plan";
import { getUserInquiries } from "@/lib/support-inquiries";
import InquiryForm from "@/components/InquiryForm";

/**
 * 問い合わせ一覧ページ
 * 支援者（support/patron）のみアクセス可能
 * 一覧表示 + 新規投稿フォーム
 */
export default async function InquiriesPage() {
  const t = await getTranslations("inquiriesPage");
  const session = await getSession();

  if (!session) return null;

  // 支援者プランチェック（basicの場合はメッセージ表示）
  const plan = await getUserPlan(session.twitchUserId);
  if (plan === "basic") {
    return (
      <div className="text-center py-12">
        <p className="text-gray-400">{t("supporterOnly")}</p>
      </div>
    );
  }

  const inquiries = await getUserInquiries(session.twitchUserId);

  // ステータスに対応する色
  const statusColors: Record<string, string> = {
    open: "bg-yellow-500/20 text-yellow-400",
    in_progress: "bg-blue-500/20 text-blue-400",
    resolved: "bg-green-500/20 text-green-400",
    closed: "bg-gray-500/20 text-gray-400",
  };

  // カテゴリに対応する色
  const categoryColors: Record<string, string> = {
    bug: "bg-red-500/20 text-red-400",
    feature: "bg-purple-500/20 text-purple-400",
    other: "bg-gray-500/20 text-gray-400",
  };

  return (
    <div>
      <h1 className="mb-2 text-2xl font-bold text-white">{t("title")}</h1>
      <p className="mb-6 text-sm text-gray-400">{t("description")}</p>

      {/* 新規投稿フォーム */}
      <div className="mb-8">
        <InquiryForm />
      </div>

      {/* 問い合わせ一覧 */}
      {inquiries.length === 0 ? (
        <p className="text-gray-400">{t("list.empty")}</p>
      ) : (
        <div className="space-y-3">
          {inquiries.map((inquiry) => (
            <Link
              key={inquiry.id}
              href={`/dashboard/inquiries/${inquiry.id}`}
              className="block rounded-xl bg-gray-800 border border-gray-700 p-4 hover:border-gray-600 transition-colors"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="mb-1 flex items-center gap-2">
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                        categoryColors[inquiry.category] || ""
                      }`}
                    >
                      {t(({ bug: "form.categoryBug", feature: "form.categoryFeature", other: "form.categoryOther" } as const)[inquiry.category] || "form.categoryOther")}
                    </span>
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                        statusColors[inquiry.status] || ""
                      }`}
                    >
                      {t(`list.status.${inquiry.status}` as 'list.status.open' | 'list.status.in_progress' | 'list.status.resolved' | 'list.status.closed')}
                    </span>
                  </div>
                  <h3 className="truncate font-medium text-white">
                    {inquiry.subject}
                  </h3>
                  <p className="mt-1 truncate text-sm text-gray-400">
                    {inquiry.body}
                  </p>
                </div>
                <span className="shrink-0 text-xs text-gray-500">
                  {new Date(inquiry.created_at).toLocaleDateString()}
                </span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
