"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

/**
 * 新規問い合わせ投稿フォーム
 * カテゴリ（バグ/機能要望/その他）+ 件名 + 本文を入力して送信
 * CSRF: HttpOnly Cookie + Origin/Referer 検証方式（src/lib/csrf.ts 参照）。
 * Cookie はブラウザが same-origin で自動送信するため、手動でトークンを付与する必要はない。
 */
export default function InquiryForm() {
  const t = useTranslations("inquiriesPage");
  const router = useRouter();
  const [category, setCategory] = useState<"bug" | "feature" | "other">("bug");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!subject.trim() || !body.trim()) return;

    setSubmitting(true);
    setError(null);
    setSuccess(false);

    const buildPostInit = (): RequestInit => ({
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ category, subject: subject.trim(), body: body.trim() }),
    });

    try {
      // 通常は HttpOnly Cookie がブラウザにより自動送信される。
      // 初回 POST で Cookie 未発行のときは 403 → /api/session で遅延発行 → 1 度だけ再試行。
      let res = await fetch("/api/support-inquiries", buildPostInit());

      if (res.status === 403) {
        const refresh = await fetch("/api/session", {
          credentials: "include",
          cache: "no-store",
        });
        if (refresh.ok) {
          res = await fetch("/api/support-inquiries", buildPostInit());
        }
      }

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || t("messages.submitFailed"));
        return;
      }

      // 送信成功 → フォームクリア＋一覧更新
      setSubject("");
      setBody("");
      setSuccess(true);
      router.refresh();
    } catch {
      setError(t("messages.networkError"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4 rounded-xl bg-gray-800 p-6">
      <h2 className="text-lg font-semibold text-white">{t("newInquiry")}</h2>

      {success && (
        <div className="rounded-lg bg-green-500/10 border border-green-500/30 p-3 text-sm text-green-400">
          {t("messages.submitSuccess")}
        </div>
      )}

      {error && (
        <div className="rounded-lg bg-red-500/10 border border-red-500/30 p-3 text-sm text-red-400">
          {error}
        </div>
      )}

      {/* カテゴリ選択 */}
      <div>
        <label className="mb-1 block text-sm font-medium text-gray-300">
          {t("form.category")}
        </label>
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value as "bug" | "feature" | "other")}
          className="w-full rounded-lg border border-gray-600 bg-gray-700 px-3 py-2 text-sm text-white"
        >
          <option value="bug">{t("form.categoryBug")}</option>
          <option value="feature">{t("form.categoryFeature")}</option>
          <option value="other">{t("form.categoryOther")}</option>
        </select>
      </div>

      {/* 件名 */}
      <div>
        <label className="mb-1 block text-sm font-medium text-gray-300">
          {t("form.subject")}
        </label>
        <input
          type="text"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          placeholder={t("form.subjectPlaceholder")}
          maxLength={200}
          className="w-full rounded-lg border border-gray-600 bg-gray-700 px-3 py-2 text-sm text-white placeholder-gray-400"
          required
        />
        <p className="mt-1 text-xs text-gray-500">{subject.length}/200</p>
      </div>

      {/* 本文 */}
      <div>
        <label className="mb-1 block text-sm font-medium text-gray-300">
          {t("form.body")}
        </label>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder={t("form.bodyPlaceholder")}
          maxLength={2000}
          rows={6}
          className="w-full rounded-lg border border-gray-600 bg-gray-700 px-3 py-2 text-sm text-white placeholder-gray-400"
          required
        />
        <p className="mt-1 text-xs text-gray-500">{body.length}/2000</p>
      </div>

      <button
        type="submit"
        disabled={submitting || !subject.trim() || !body.trim()}
        className="rounded-lg bg-purple-600 px-4 py-2 text-sm font-medium text-white hover:bg-purple-700 disabled:opacity-50"
      >
        {submitting ? t("form.submitting") : t("form.submit")}
      </button>
    </form>
  );
}
