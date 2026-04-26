"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

interface Message {
  id: string;
  sender_type: "user" | "admin";
  sender_id: string;
  body: string;
  created_at: string;
}

interface InquiryThreadProps {
  inquiryId: string;
  status: string;
  initialBody: string;
  createdAt: string;
  messages: Message[];
}

/**
 * 問い合わせスレッド表示 + 返信フォーム
 * 初回投稿本文 + 後続メッセージを時系列で表示
 * closed ステータス時は返信フォームを非表示
 */
export default function InquiryThread({
  inquiryId,
  status,
  initialBody,
  createdAt,
  messages,
}: InquiryThreadProps) {
  const t = useTranslations("inquiriesPage");
  const router = useRouter();
  const [replyBody, setReplyBody] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const isClosed = status === "closed";

  const handleReply = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!replyBody.trim()) return;

    setSubmitting(true);
    setError(null);
    setSuccess(false);

    try {
      // CSRF: HttpOnly Cookie + Origin/Referer 検証方式（src/lib/csrf.ts 参照）。
      // ブラウザが same-origin で自動送信する Cookie をサーバーが検証するため、
      // クライアント側でトークンを取得・送信する必要はない。CSRF Cookie 未発行で
      // 403 が返った場合のみ、/api/session を叩いて遅延発行してから 1 度だけ再試行する。
      let res = await fetch(`/api/support-inquiries/${inquiryId}/messages`, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ body: replyBody.trim() }),
      });

      if (res.status === 403) {
        const refresh = await fetch("/api/session", {
          credentials: "include",
          cache: "no-store",
        });
        if (refresh.ok) {
          res = await fetch(`/api/support-inquiries/${inquiryId}/messages`, {
            method: "POST",
            credentials: "include",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ body: replyBody.trim() }),
          });
        }
      }

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || t("messages.replyFailed"));
        return;
      }

      setReplyBody("");
      setSuccess(true);
      router.refresh();
    } catch {
      setError(t("messages.networkError"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-4">
      <h3 className="text-lg font-semibold text-white">{t("detail.thread")}</h3>

      {/* 初回投稿 */}
      <div className="rounded-lg border border-gray-600 bg-gray-800 p-4">
        <div className="mb-2 flex items-center gap-2">
          <span className="rounded-full bg-purple-600 px-2 py-0.5 text-xs font-medium text-white">
            {t("detail.yourMessage")}
          </span>
          <span className="text-xs text-gray-500">
            {new Date(createdAt).toLocaleString()}
          </span>
        </div>
        <p className="whitespace-pre-wrap text-sm text-gray-300">{initialBody}</p>
      </div>

      {/* 後続メッセージ */}
      {messages.map((msg) => (
        <div
          key={msg.id}
          className={`rounded-lg border p-4 ${
            msg.sender_type === "admin"
              ? "border-blue-500/30 bg-blue-900/20"
              : "border-gray-600 bg-gray-800"
          }`}
        >
          <div className="mb-2 flex items-center gap-2">
            <span
              className={`rounded-full px-2 py-0.5 text-xs font-medium text-white ${
                msg.sender_type === "admin" ? "bg-blue-600" : "bg-purple-600"
              }`}
            >
              {msg.sender_type === "admin"
                ? t("detail.adminReply")
                : t("detail.yourMessage")}
            </span>
            <span className="text-xs text-gray-500">
              {new Date(msg.created_at).toLocaleString()}
            </span>
          </div>
          <p className="whitespace-pre-wrap text-sm text-gray-300">{msg.body}</p>
        </div>
      ))}

      {/* 返信フォーム or クローズ通知 */}
      {isClosed ? (
        <div className="rounded-lg border border-gray-600 bg-gray-800/50 p-4 text-center text-sm text-gray-400">
          {t("detail.closedNotice")}
        </div>
      ) : (
        <form onSubmit={handleReply} className="space-y-3">
          {success && (
            <div className="rounded-lg bg-green-500/10 border border-green-500/30 p-3 text-sm text-green-400">
              {t("messages.replySuccess")}
            </div>
          )}
          {error && (
            <div className="rounded-lg bg-red-500/10 border border-red-500/30 p-3 text-sm text-red-400">
              {error}
            </div>
          )}
          <textarea
            value={replyBody}
            onChange={(e) => setReplyBody(e.target.value)}
            placeholder={t("detail.replyPlaceholder")}
            aria-label={t("detail.reply")}
            maxLength={2000}
            rows={4}
            className="w-full rounded-lg border border-gray-600 bg-gray-700 px-3 py-2 text-sm text-white placeholder-gray-400"
            required
          />
          <div className="flex items-center justify-between">
            <p className="text-xs text-gray-500">{replyBody.length}/2000</p>
            <button
              type="submit"
              disabled={submitting || !replyBody.trim()}
              className="rounded-lg bg-purple-600 px-4 py-2 text-sm font-medium text-white hover:bg-purple-700 disabled:opacity-50"
            >
              {submitting ? t("detail.replying") : t("detail.reply")}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
